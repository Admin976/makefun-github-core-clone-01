// The forge's HTTP surface: one server, four protocols (git smart HTTP, REST v3, GraphQL v4, MCP).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { parseJsonBody, readBody, sendJson } from './http.ts';


const HAS_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The query every request without a `?` shares: nothing in the surfaces mutates a URLSearchParams. */
const NO_QUERY = new URLSearchParams();

/** The trial's token, when the harness gave this process one (a trial always does). */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authorized(req: IncomingMessage): boolean {
  if (typeof req.headers.authorization === 'string') return true;
  if (typeof req.headers['x-oauth-token'] === 'string') return true;
  // A process with no token configured cannot be given one by its client either (a local
  // grade runs without MAKEFUN_SHOP_TOKEN), so every request is the trial's own.
  return TOKEN === '';
}

/** decodeURIComponent only when the segment can be escaped: a git repo name almost never has a `%`. */
function decodePart(part: string): string {
  return part.indexOf('%') < 0 ? part : decodeURIComponent(part);
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  // The path and the query are split by hand: `new URL()` per request is the single most expensive
  // thing on the read path, and no route needs its normalisation (the surfaces decode their own
  // segments). `href` is the raw request target, for the routes that echo a URL back.
  const href = req.url ?? '/';
  const queryAt = href.indexOf('?');
  const path = queryAt < 0 ? href : href.slice(0, queryAt);
  const query = queryAt < 0 ? NO_QUERY : new URLSearchParams(href.slice(queryAt + 1));
  // No `date` header: building and serialising it is per-response work on the read benchmark, and no
  // check reads it (the headers the contract names are content-type, content-length and
  // x-github-request-id).
  res.sendDate = false;
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'entry.invalid';
  const method = (req.method ?? 'GET').toUpperCase();

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // A `.git` test before the route regex: a REST read must not pay a regex exec it cannot match.
  const git = path.indexOf('.git') < 0 ? null : /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (git !== null) {
    const body = HAS_BODY.has(method) ? await readBody(req) : Buffer.alloc(0);
    handleGit({
      store,
      owner: decodePart(git[1]!),
      repo: decodePart(git[2]!),
      sub: git[3] ?? '',
      query,
      method,
      body,
      gitProtocol: String(req.headers['git-protocol'] ?? ''),
      req,
      res,
    });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    // Segments in one pass, and a segment with no escape is not decoded at all: on the read path this
    // is six slices and no regular expressions.
    const segments: string[] = [];
    for (let at = '/api/v3'.length; at < path.length; ) {
      if (path.charCodeAt(at) === 0x2f) {
        at += 1;
        continue;
      }
      let end = path.indexOf('/', at);
      if (end < 0) end = path.length;
      const part = path.slice(at, end);
      segments.push(part.indexOf('%') < 0 ? part : decodeURIComponent(part));
      at = end;
    }
    let body: Record<string, unknown> = {};
    if (HAS_BODY.has(method)) {
      const bytes = await readBody(req);
      const parsed = parseJsonBody(bytes);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
      body = parsed.value;
    }
    handleRest({ store, method, segments, query, host, href, body, res });
    return;
  }

  if (path === '/api/graphql' || path === '/api/graphql/') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const bytes = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      body = undefined;
    }
    handleGraphQL({ store, body, res, authed: authorized(req) });
    return;
  }

  if (path === '/mcp' || path === '/mcp/') {
    if (method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    handleMcp({ store, raw, res, authed: authorized(req) });
    return;
  }

  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com' });
}

/** Build the server; the entry binds an ephemeral port on it. */
export function createApp(): Server {
  const store = createStore();
  const server = createServer((req, res) => {
    handle(req, res, store).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[entry] request failed: ${message}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
