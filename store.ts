// The forge's store: git objects, refs and the REST entities, all in memory, one process.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The token's login, fixed by the suite's scenario (SCENARIO_SEED is a build constant). */
export const OWNER = 'adaiversen';
export const OWNER_NAME = 'Ada Iversen';
export const OWNER_EMAIL = 'adaiversen@example.invalid';
/** The stranger the foreign-token check reads under: never this token's owner. */
export const STRANGER = 'olgabauer';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

export function writeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function readObject(repo: Repo, oid: string): GitObj | undefined {
  return repo.objects.get(oid);
}

// ---------------------------------------------------------------- deterministic clock

const BASE_MS = Date.UTC(2026, 9, 28, 0, 0, 0);
let tick = 0;
/** A monotonic, deterministic timestamp: no wall clock ever reaches the wire. */
export function nowIso(): string {
  tick += 1;
  return new Date(BASE_MS + tick * 1000).toISOString();
}
export function nowEpoch(): number {
  return Math.floor(BASE_MS / 1000) + tick;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const mode = data.subarray(i, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

/** git's tree order: a directory sorts as its name with a trailing '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function makeCommit(input: {
  tree: string;
  parents: string[];
  message: string;
  when: string;
  epoch: number;
  authorName?: string;
  authorEmail?: string;
}): Buffer {
  const name = input.authorName ?? OWNER_NAME;
  const email = input.authorEmail ?? OWNER_EMAIL;
  const who = `${name} <${email}> ${input.epoch} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`);
  lines.push(`committer ${who}`);
  const body = `${lines.join('\n')}\n\n${input.message.endsWith('\n') ? input.message : `${input.message}\n`}`;
  return Buffer.from(body, 'utf8');
}

// ---------------------------------------------------------------- entities

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  defaultBranch: string;
  issues: Issue[];
  labels: Label[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
}

export interface Store {
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  nextLabelId: number;
}

export function createStore(): Store {
  return { repos: new Map(), nextRepoId: 1000, nextIssueId: 1, nextPullId: 1, nextCommentId: 1, nextLabelId: 1 };
}

function key(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(key(owner, name));
}

export function createRepo(store: Store, owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: store.nextRepoId++,
    owner,
    name,
    description: description ?? '',
    isPrivate,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    objects: new Map(),
    refs: new Map(),
    defaultBranch: 'main',
    issues: [],
    labels: [],
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
  };
  store.repos.set(key(owner, name), repo);
  return repo;
}

export function deleteRepo(store: Store, owner: string, name: string): boolean {
  return store.repos.delete(key(owner, name));
}

// ---------------------------------------------------------------- trees over a repo

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every file (blob) path in a tree, flattened: path -> entry. */
export function flattenTree(repo: Repo, rootOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const obj = repo.objects.get(rootOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Rebuild a tree with `path` set to `blobOid` (or removed when null); returns the new root oid. */
export function withPath(repo: Repo, rootOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((part) => part !== '');
  const existing = rootOid === null ? [] : parseTreeEntryList(repo, rootOid);
  return rebuild(repo, existing, segments, blobOid);
}

function parseTreeEntryList(repo: Repo, oid: string): TreeEntry[] {
  const obj = repo.objects.get(oid);
  return obj && obj.type === 'tree' ? parseTree(obj.data) : [];
}

function rebuild(repo: Repo, entries: TreeEntry[], segments: string[], blobOid: string | null): string {
  const [head, ...rest] = segments;
  const restEntries = entries.filter((entry) => entry.name !== head);
  const current = entries.find((entry) => entry.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      // removing a file: drop it, and re-hash the directory it lived in
      return writeObject(repo, 'tree', buildTree(restEntries));
    }
    restEntries.push({ mode: '100644', name: head, oid: blobOid });
    return writeObject(repo, 'tree', buildTree(restEntries));
  }
  const childEntries = current && current.mode === '40000' ? parseTreeEntryList(repo, current.oid) : [];
  const childOid = rebuild(repo, childEntries, rest, blobOid);
  const childTree = repo.objects.get(childOid);
  const kept = childTree && childTree.type === 'tree' && childTree.data.length > 0;
  if (!kept) return writeObject(repo, 'tree', buildTree(restEntries));
  restEntries.push({ mode: '40000', name: head, oid: childOid });
  return writeObject(repo, 'tree', buildTree(restEntries));
}

// ---------------------------------------------------------------- refs and graph

export function refOid(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function branchOid(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(branch);
}

export function headOid(repo: Repo): string | undefined {
  return branchOid(repo, repo.defaultBranch);
}

/** Every object reachable from `roots`, optionally stopping commit traversal at `boundaries`. */
export function reachable(
  repo: Repo,
  roots: Iterable<string>,
  options: { boundaries?: ReadonlySet<string>; maxDepth?: number } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) queue.push({ oid: root, depth: 0 });
  while (queue.length > 0) {
    const { oid, depth } = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      if (options.maxDepth !== undefined && depth >= options.maxDepth) continue;
      if (options.boundaries && options.boundaries.has(oid)) continue;
      const info = parseCommit(obj.data);
      queue.push({ oid: info.tree, depth: depth + 1 });
      for (const parent of info.parents) queue.push({ oid: parent, depth: depth + 1 });
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) queue.push({ oid: match[1]!, depth });
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push({ oid: entry.oid, depth: depth + 1 });
    }
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** A common ancestor of two commits, or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOf = (start: string): Map<string, number> => {
    const depth = new Map<string, number>();
    const queue: Array<[string, number]> = [[start, 0]];
    while (queue.length > 0) {
      const [oid, d] = queue.shift()!;
      if (depth.has(oid)) continue;
      depth.set(oid, d);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
    }
    return depth;
  };
  const left = ancestorsOf(a);
  const right = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, d] of left) {
    const other = right.get(oid);
    if (other === undefined) continue;
    const score = d + other;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------- packs

function writePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** A version-2 pack of `objects`, uncompressed bases only (no deltas), with its sha1 trailer. */
export function writePack(objects: ReadonlyArray<GitObj>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

/** The exact compressed length of the deflate stream starting at `offset` (binary search on inflate). */
function deflateLength(buf: Buffer, offset: number, size: number, hint: number): number {
  const limit = buf.length - 20 - offset;
  const fits = (length: number): boolean => {
    if (length <= 0 || length > limit) return false;
    try {
      const out = inflateSync(buf.subarray(offset, offset + length));
      return out.length === size;
    } catch {
      return false;
    }
  };
  const shrink = (high: number): number => {
    let lo = 1;
    let hi = high;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  let probe = Math.max(1, Math.min(hint > 0 ? hint : 32, limit));
  if (fits(probe)) return shrink(probe);
  while (probe < limit) {
    const next = Math.min(limit, probe * 2);
    if (fits(next)) {
      let lo = probe;
      let hi = next;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    probe = next;
  }
  throw new Error('bad pack object: the deflate stream does not end inside the pack');
}

function readPackObjectHeader(buf: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  let byte = buf[offset]!;
  let typeCode = (byte >> 4) & 7;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos]!;
    pos += 1;
    size += (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, next: pos };
}

const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Parse a pack buffer into its objects (deltas resolved against objects already held). */
export function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  const objects = new Map<string, GitObj>();
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') return objects;
  const count = buf.readUInt32BE(8);
  let offset = 12;
  let hint = 0;
  const pending: Array<{ typeCode: number; base?: string; baseOffset?: number; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    const header = readPackObjectHeader(buf, offset);
    let dataOffset = header.next;
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (header.typeCode === 6) {
      // OFS_DELTA: a negative offset varint
      let byte = buf[dataOffset]!;
      let value = byte & 0x7f;
      let pos = dataOffset + 1;
      while ((byte & 0x80) !== 0) {
        byte = buf[pos]!;
        pos += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = offset - value;
      dataOffset = pos;
    } else if (header.typeCode === 7) {
      baseOid = buf.subarray(dataOffset, dataOffset + 20).toString('hex');
      dataOffset += 20;
    }
    const length = deflateLength(buf, dataOffset, header.size, hint);
    hint = length;
    const raw = inflateSync(buf.subarray(dataOffset, dataOffset + length));
    offset = dataOffset + length;
    if (header.typeCode === 6 || header.typeCode === 7) {
      pending.push({ typeCode: header.typeCode, base: baseOid, baseOffset, data: raw });
    } else {
      const type = CODE_TYPE[header.typeCode];
      if (type) objects.set(hashObject(type, raw), { type, data: raw });
    }
  }
  for (const delta of pending) {
    const base = delta.base !== undefined ? (objects.get(delta.base) ?? resolveBase?.(delta.base)) : undefined;
    const resolved = base === undefined ? undefined : applyDelta(base, delta.data);
    if (resolved) objects.set(hashObject(base!.type, resolved), { type: base!.type, data: resolved });
  }
  return objects;
}

function applyDelta(base: GitObj, delta: Buffer): Buffer | undefined {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  readVarint();
  const targetSize = readVarint();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[pos++]!;
      if (op & 0x02) copyOffset |= delta[pos++]! << 8;
      if (op & 0x04) copyOffset |= delta[pos++]! << 16;
      if (op & 0x08) copyOffset |= delta[pos++]! << 24;
      if (op & 0x10) copySize |= delta[pos++]!;
      if (op & 0x20) copySize |= delta[pos++]! << 8;
      if (op & 0x40) copySize |= delta[pos++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      base.data.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, pos, pos + op);
      written += op;
      pos += op;
    } else {
      return undefined;
    }
  }
  return out.subarray(0, written);
}
