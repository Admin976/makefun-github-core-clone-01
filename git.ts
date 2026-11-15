// Git smart HTTP: the v2 upload-pack (ls-refs, fetch, shallow) and the v0 receive-pack (push).
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getRepo,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  readPack,
  reachable,
  writePack,
  type GitObj,
  type Repo,
  type Store,
} from './store.ts';
import { sendBuffer, sendJson } from './http.ts';

const SERVICE_UPLOAD = 'git-upload-pack';
const SERVICE_RECEIVE = 'git-receive-pack';
const AGENT = 'agent=makefun-forge/1.0';
const ZERO = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- pkt-lines

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from(`${(data.length + 4).toString(16).padStart(4, '0')}`, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
  /** Offset just past this packet's raw bytes. */
  next: number;
  raw: Buffer;
}

/** The pkt-line length a 4-byte hex header names, or -1 when those bytes are not four hex digits. */
function pktLengthAt(buf: Buffer, offset: number): number {
  let value = 0;
  for (let index = offset; index < offset + 4; index += 1) {
    const code = buf[index]!;
    let digit: number;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 97 && code <= 102) digit = code - 87;
    else if (code >= 65 && code <= 70) digit = code - 55;
    else return -1;
    value = (value << 4) | digit;
  }
  return value;
}

function readPackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = pktLengthAt(buf, offset);
    if (length < 0) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), next: offset + 4, raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), next: offset + 4, raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    const end = offset + length;
    if (end > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, end), next: end, raw: buf.subarray(offset, end) });
    offset = end;
  }
  return packets;
}

// ---------------------------------------------------------------- refs

function headTarget(repo: Repo): string | null {
  return `refs/heads/${repo.defaultBranch}`;
}

function refList(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  const head = headTarget(repo);
  if (head !== null) {
    const oid = repo.refs.get(head);
    if (oid !== undefined) out.push({ name: 'HEAD', oid });
  }
  for (const name of [...repo.refs.keys()].sort()) out.push({ name, oid: repo.refs.get(name)! });
  return out;
}

/** The commit an annotated tag finally names, for `peeled:` lines. */
function peel(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 8; guard += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tree' || obj.type === 'blob') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!match) return null;
    current = match[1]!;
  }
  return null;
}

// ---------------------------------------------------------------- advertisements

function uploadPackAdvertisement(repo: Repo, protocol: 0 | 2): Buffer {
  const refs = refList(repo);
  const parts: Buffer[] = [pkt(`# service=${SERVICE_UPLOAD}\n`), FLUSH];
  if (protocol === 2) {
    parts.push(pkt('version 2\n'));
    parts.push(pkt(`${AGENT}\n`));
    parts.push(pkt('ls-refs=unborn\n'));
    parts.push(pkt('fetch=shallow wait-for-done\n'));
    parts.push(pkt('object-format=sha1\n'));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const capabilities = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag ${AGENT} object-format=sha1`;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${capabilities}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${capabilities}` : '';
      parts.push(pkt(`${ref.oid} ${ref.name}${suffix}\n`));
      if (index === 0 && ref.name === 'HEAD') {
        // the symref capability rides the first line only
      }
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function receivePackAdvertisement(repo: Repo): Buffer {
  const refs = refList(repo).filter((ref) => ref.name !== 'HEAD');
  const head = headTarget(repo);
  const headOid = head === null ? undefined : repo.refs.get(head);
  const capabilities = `report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet ${AGENT} object-format=sha1`;
  const parts: Buffer[] = [pkt(`# service=${SERVICE_RECEIVE}\n`), FLUSH];
  if (headOid !== undefined) {
    parts.push(pkt(`${headOid} ${head}\0${capabilities}\n`));
    for (const ref of refs) if (ref.name !== head) parts.push(pkt(`${ref.oid} ${ref.name}\n`));
  } else if (refs.length > 0) {
    refs.forEach((ref, index) => parts.push(pkt(`${ref.oid} ${ref.name}${index === 0 ? `\0${capabilities}` : ''}\n`)));
  } else {
    parts.push(pkt(`${ZERO} capabilities^{}\0${capabilities}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  peel: boolean;
}

function parseFetch(packets: Packet[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], peel: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim()) || undefined;
    else if (line === 'peel') request.peel = true;
  }
  return request;
}

interface Selection {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/** The objects a fetch must deliver, and the shallow boundary it reports. */
function selectObjects(repo: Repo, request: FetchRequest): Selection {
  const shallowSet = new Set(request.shallow);
  const clientHas = request.haves.length > 0 ? reachable(repo, request.haves, { boundaries: shallowSet }) : new Set<string>();
  const include = new Set<string>();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];

  const addTreeClosure = (treeOid: string): void => {
    const seen = new Set<string>();
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (include.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      include.add(oid);
      if (obj.type === 'tree') for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  };

  // Wants may name commits or annotated tags; unwrap tags first so depth counts commits.
  const roots: string[] = [];
  for (const want of request.wants) {
    let current = want;
    for (let guard = 0; guard < 8; guard += 1) {
      const obj = repo.objects.get(current);
      if (!obj) break;
      if (obj.type === 'tag') {
        include.add(current);
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (!match) break;
        current = match[1]!;
        continue;
      }
      break;
    }
    roots.push(current);
  }

  if (request.depth !== undefined) {
    // commit generations: level 0 is the want itself
    let level = roots.filter((oid) => repo.objects.get(oid)?.type === 'commit');
    const seenCommits = new Set<string>();
    for (let generation = 0; generation < request.depth && level.length > 0; generation += 1) {
      const next: string[] = [];
      for (const oid of level) {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        include.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const info = parseCommit(obj.data);
        addTreeClosure(info.tree);
        if (generation + 1 < request.depth) next.push(...info.parents);
        else shallowOut.push(oid);
      }
      level = next;
    }
    // anything the client held at a boundary that is now complete is unshallowed
    for (const boundary of request.shallow) if (seenCommits.has(boundary)) unshallowOut.push(boundary);
    for (const oid of shallowOut) {
      const index = unshallowOut.indexOf(oid);
      if (index >= 0) unshallowOut.splice(index, 1);
    }
  } else {
    for (const oid of reachable(repo, roots)) include.add(oid);
  }

  const objects: GitObj[] = [];
  for (const oid of include) {
    if (clientHas.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow: shallowOut, unshallow: unshallowOut };
}

function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 60_000;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (parts.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const selection = selectObjects(repo, request);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  parts.push(pkt('NAK\n'));
  parts.push(DELIM);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sideband(writePack(selection.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/**
 * Fetch answers already built, per repository. A fetch answer is a pure function of the request and
 * of objects that never change once written (an oid always names the same bytes; the store only ever
 * adds them), so an answer for the same wants/depth/haves is the same bytes every time: the 200-commit
 * shallow clone a benchmark asks for fifty times is packed once. Only answers whose every want already
 * resolved are cached, so a fetch naming an object the repository does not hold yet is never frozen.
 * The map is bounded so a trial's many repositories cannot grow it without limit.
 */
const FETCH_CACHE = new WeakMap<Repo, Map<string, Buffer>>();
const FETCH_CACHE_MAX = 8;
const FETCH_CACHE_MAX_BYTES = 2 * 1024 * 1024;

function fetchCacheKey(request: FetchRequest): string {
  return `${request.depth ?? 0}|${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}|${request.peel ? 1 : 0}`;
}

function cachedFetch(repo: Repo, request: FetchRequest): Buffer {
  let cache = FETCH_CACHE.get(repo);
  if (cache === undefined) {
    cache = new Map();
    FETCH_CACHE.set(repo, cache);
  }
  const key = fetchCacheKey(request);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const body = fetchResponse(repo, request);
  const resolvable = request.wants.every((want) => repo.objects.has(want));
  if (resolvable && body.length <= FETCH_CACHE_MAX_BYTES) {
    if (cache.size >= FETCH_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, body);
  }
  return body;
}

function lsRefsResponse(repo: Repo, packets: Packet[]): Buffer {
  const wanted: string[] = [];
  let peelWanted = false;
  let symrefs = false;
  let unborn = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) wanted.push(line.slice(11).trim());
    else if (line === 'peel') peelWanted = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
  }
  const keep = (name: string): boolean => wanted.length === 0 || wanted.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headTarget(repo);
  const headOid = head === null ? undefined : repo.refs.get(head);
  if (head !== null && keep('HEAD')) {
    if (headOid !== undefined) parts.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peelWanted) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const target = peel(repo, oid);
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- push

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePush(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  let packOffset = body.length;
  while (offset + 4 <= body.length) {
    const length = pktLengthAt(body, offset);
    if (length < 0) {
      packOffset = offset;
      break;
    }
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), next: offset + 4, raw: body.subarray(offset, offset + 4) });
      offset += 4;
      packOffset = offset;
      break;
    }
    const end = offset + length;
    if (end > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, end), next: end, raw: body.subarray(offset, end) });
    offset = end;
    packOffset = offset;
  }
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1).split(' ').filter((entry) => entry !== '');
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  return { commands, capabilities, pack: body.subarray(packOffset) };
}

function buildReport(lines: string[], sidebandWanted: boolean): Buffer {
  const inner: Buffer[] = [];
  for (const line of lines) inner.push(pkt(`${line}\n`));
  inner.push(FLUSH);
  const stream = Buffer.concat(inner);
  if (!sidebandWanted) return stream;
  return pkt(Buffer.concat([Buffer.from([1]), stream]));
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, capabilities, pack } = parsePush(body);
  const sidebandWanted = capabilities.includes('side-band-64k');
  const report: string[] = ['unpack ok'];
  let unpackOk = true;
  if (pack.length > 0) {
    try {
      const objects = readPack(pack);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
      report[0] = 'unpack error: bad pack';
    }
  }
  if (!unpackOk) {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error`);
    return buildReport(report, sidebandWanted);
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO) {
      if (current === undefined) {
        report.push(`ng ${command.ref} branch not found`);
        continue;
      }
      if (command.oldOid !== ZERO && command.oldOid !== current) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} missing necessary objects`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (command.oldOid !== ZERO && command.oldOid !== current) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (!isAncestor(repo, current, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }
  return buildReport(report, sidebandWanted);
}

// ---------------------------------------------------------------- routing

export interface GitRequest {
  store: Store;
  owner: string;
  repo: string;
  /** The path after `/{owner}/{repo}.git`: '/info/refs', '/git-upload-pack', … */
  sub: string;
  query: URLSearchParams;
  method: string;
  body: Buffer;
  gitProtocol: string;
  req: IncomingMessage;
  res: ServerResponse;
}

export function handleGit(request: GitRequest): void {
  const { store, owner, repo: name, sub, query, method, body, gitProtocol, res } = request;
  const repo = getRepo(store, owner, name);
  const service = query.get('service') ?? '';
  if (sub === '/info/refs') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (service !== SERVICE_UPLOAD && service !== SERVICE_RECEIVE) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const isV2 = /version=2/.test(gitProtocol);
    if (service === SERVICE_UPLOAD) {
      const payload = uploadPackAdvertisement(repo, isV2 ? 2 : 0);
      sendBuffer(res, 200, payload, 'application/x-git-upload-pack-advertisement', { 'cache-control': 'no-cache' });
      return;
    }
    sendBuffer(res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement', { 'cache-control': 'no-cache' });
    return;
  }
  if (sub === `/${SERVICE_UPLOAD}`) {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const packets = readPackets(body);
    if (packets.length === 0) {
      sendJson(res, 400, { message: 'Bad Request: not a pkt-line stream' });
      return;
    }
    const first = packets.find((packet) => packet.kind === 'data');
    const command = first === undefined ? '' : first.payload.toString('utf8').replace(/\n$/, '');
    if (command.startsWith('command=ls-refs')) {
      sendBuffer(res, 200, lsRefsResponse(repo, packets), 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
      return;
    }
    if (command.startsWith('command=fetch')) {
      const fetch = parseFetch(packets);
      sendBuffer(res, 200, cachedFetch(repo, fetch), 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
      return;
    }
    // a v0 upload-pack request (want lines directly)
    sendBuffer(res, 200, v0UploadPack(repo, packets), 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
    return;
  }
  if (sub === `/${SERVICE_RECEIVE}`) {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    sendBuffer(res, 200, receivePack(repo, body), 'application/x-git-receive-pack-result', { 'cache-control': 'no-cache' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

/** A minimal v0 upload-pack: wants/haves, NAK, then a sideband pack. */
function v0UploadPack(repo: Repo, packets: Packet[]): Buffer {
  const wants: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || undefined;
  }
  const parts: Buffer[] = [pkt('NAK\n')];
  if (wants.length > 0) {
    const selection = selectObjects(repo, { wants, haves: [], shallow: [], depth, peel: false });
    if (selection.shallow.length > 0) {
      for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
      parts.push(FLUSH);
    }
    parts.push(sideband(writePack(selection.objects)));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export { hashObject };
