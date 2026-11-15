// The MCP endpoint: JSON-RPC 2.0 over the Streamable HTTP transport, acting on the same store as REST.
import type { ServerResponse } from 'node:http';
import { OWNER, branchOid, createRepo, getRepo, nowIso, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { squashMerge } from './gql.ts';
import { sendJson } from './http.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

interface Tool {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): Tool {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [key, value] of Object.entries(properties)) props[key] = { type: 'string', description: value };
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The tool list: built once, so two tools/list answers are byte-identical. */
const TOOLS: Tool[] = [
  tool('create_repo', 'Create a repository in the forge and return it', { name: 'the repository name', description: 'a short description', private: 'true for a private repository' }, ['name']),
  tool('get_repo', 'Read a repository by owner and name', { owner: 'the repository owner', repo: 'the repository name' }, ['owner', 'repo']),
  tool('create_issue', 'Open an issue on a repository', { owner: 'the repository owner', repo: 'the repository name', title: 'the issue title', body: 'the issue body' }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository', { owner: 'the repository owner', repo: 'the repository name', state: 'open, closed or all' }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch onto a base branch', { owner: 'the repository owner', repo: 'the repository name', title: 'the pull request title', head: 'the head branch', base: 'the base branch' }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request into its base branch', { owner: 'the repository owner', repo: 'the repository name', pull_number: 'the pull request number' }, ['owner', 'repo', 'pull_number']),
  tool('get_file', 'Read a file from a repository at a ref', { owner: 'the repository owner', repo: 'the repository name', path: 'the path inside the repository' }, ['owner', 'repo', 'path']),
  tool('list_branches', 'List the branches of a repository', { owner: 'the repository owner', repo: 'the repository name' }, ['owner', 'repo']),
];

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
  };
}

function issueSummary(issue: Issue): Record<string, unknown> {
  return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels, comments: issue.comments.length };
}

function pullSummary(pull: Pull): Record<string, unknown> {
  return { id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, merged: pull.merged, head: pull.head, base: pull.base };
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: false };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | undefined {
  const fullName = argStr(args, 'full_name') || argStr(args, 'fullName');
  let owner = argStr(args, 'owner');
  let name = argStr(args, 'repo') || argStr(args, 'name');
  if (fullName.includes('/')) {
    const parts = fullName.split('/');
    if (owner === '') owner = parts[0] ?? '';
    if (name === '') name = parts[1] ?? '';
  }
  if (owner === '') owner = OWNER;
  if (name === '') name = argStr(args, 'name');
  return getRepo(store, owner, name);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const toolName = bare.toLowerCase();
  switch (toolName) {
    case 'create_repo': {
      const repoName = argStr(args, 'name') || argStr(args, 'repo');
      if (repoName === '') return toolError('create_repo requires a name');
      if (getRepo(store, OWNER, repoName) !== undefined) return toolError(`repository ${OWNER}/${repoName} already exists`);
      const repo = createRepo(store, OWNER, repoName, argStr(args, 'description'), args.private === true || args.private === 'true');
      return ok(repoSummary(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      return ok(repoSummary(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const title = argStr(args, 'title');
      if (title === '') return toolError('create_issue requires a title');
      const when = nowIso();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssue++,
        title,
        body: argStr(args, 'body'),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: when,
        updatedAt: when,
        closedAt: null,
      };
      repo.issues.push(issue);
      return ok(issueSummary(issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const state = argStr(args, 'state') || 'open';
      const list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      return ok({ total_count: list.length, issues: list.map(issueSummary) });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const head = argStr(args, 'head');
      const base = argStr(args, 'base') || repo.defaultBranch;
      if (branchOid(repo, head) === undefined) return toolError(`head branch ${head} does not exist`);
      const when = nowIso();
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextPull++,
        title: argStr(args, 'title'),
        body: argStr(args, 'body'),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
        createdAt: when,
        updatedAt: when,
      };
      repo.pulls.push(pull);
      return ok(pullSummary(pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const number = Number(argStr(args, 'pull_number') || argStr(args, 'number'));
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError(`pull request ${number} not found`);
      const merged = squashMerge(repo, pull);
      if (!merged) return toolError(`pull request ${number} is not mergeable`);
      return ok({ ...pullSummary(pull), sha: pull.mergeCommitSha, merged: true });
    }
    case 'get_file': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      return ok({ path: argStr(args, 'path'), message: 'contents are served over the contents API' });
    }
    case 'list_branches': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ({ name: ref.slice(11), commit: { sha: repo.refs.get(ref)! } }));
      return ok({ branches });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export interface McpContext {
  store: Store;
  raw: Buffer;
  res: ServerResponse;
  authed: boolean;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function reply(res: ServerResponse, id: string | number | null | undefined, result: unknown, session: boolean): void {
  const headers: Record<string, string> = {};
  if (session) headers['mcp-session-id'] = 'makefun-session';
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result }, headers);
}

function replyError(res: ServerResponse, id: string | number | null | undefined, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export function handleMcp(ctx: McpContext): void {
  const { store, raw, res, authed } = ctx;
  if (!authed) {
    sendJson(res, 401, { error: 'unauthorized', error_description: 'a bearer token is required' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON' } });
    return;
  }
  const batch = Array.isArray(parsed);
  const requests = (batch ? parsed : [parsed]) as JsonRpcRequest[];
  const answers = requests.map((request) => {
    if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const id = request.id ?? null;
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case 'server/discover':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PREFERRED_REVISION,
            supportedVersions: [...SUPPORTED_VERSIONS],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
          },
        };
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
        const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: chosen,
            supportedVersions: [...SUPPORTED_VERSIONS],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return { jsonrpc: '2.0', id, result: {} };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        const known = TOOLS.find((entry) => entry.name.toLowerCase() === name.toLowerCase() || name.toLowerCase().endsWith(`__${entry.name.toLowerCase()}`));
        if (known === undefined) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } };
        }
        const missing = known.inputSchema.required.filter((key) => {
          const value = args[key];
          return value === undefined || value === null || value === '';
        });
        if (missing.length > 0) {
          const result: ToolResult = { content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }], isError: true };
          return { jsonrpc: '2.0', id, result };
        }
        const result = callTool(store, name, args);
        return { jsonrpc: '2.0', id, result };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    }
  });
  const headers: Record<string, string> = {};
  if (requests.some((request) => request.method === 'initialize')) headers['mcp-session-id'] = 'makefun-session';
  sendJson(res, 200, batch ? answers : answers[0], headers);
}
