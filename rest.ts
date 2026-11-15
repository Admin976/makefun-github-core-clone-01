// The REST v3 surface: repositories, contents, branches, commits, labels, issues, comments and pulls.
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  OWNER,
  OWNER_EMAIL,
  OWNER_NAME,
  branchOid,
  buildTree,
  createRepo,
  deleteRepo,
  flattenTree,
  getRepo,
  headOid,
  makeCommit,
  mergeBase,
  nowIso,
  parseCommit,
  parseTree,
  readObject,
  refOid,
  writeObject,
  withPath,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { sendEmpty, sendJson, sendJsonPayload } from './http.ts';

const USER_ID = 1000;

function userJson(login = OWNER): Record<string, unknown> {
  return {
    login,
    id: USER_ID,
    node_id: `MDQ6VXNlcj${USER_ID}`,
    avatar_url: 'https://avatars.example.invalid/u/1000',
    type: 'User',
    site_admin: false,
    html_url: `https://forge.invalid/${login}`,
    url: `https://forge.invalid/api/v3/users/${login}`,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `MDEwOlJlcG9zaXRvcnk${repo.id}`,
    name: repo.name,
    full_name: full,
    private: repo.isPrivate,
    owner: userJson(repo.owner),
    html_url: `https://forge.invalid/${full}`,
    url: `https://forge.invalid/api/v3/repos/${full}`,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `MDU6TGFiZWw${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const labels = issue.labels.map((name) => {
    const found = repo.labels.find((label) => label.name === name);
    return found ? labelJson(found) : { id: 0, name, color: 'ededed', description: '', default: false };
  });
  return {
    id: issue.id,
    node_id: `MDU6SXNzdWU${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://forge.invalid/${full}/issues/${issue.number}`,
    url: `https://forge.invalid/api/v3/repos/${full}/issues/${issue.number}`,
    repository_url: `https://forge.invalid/api/v3/repos/${full}`,
    comments_url: `https://forge.invalid/api/v3/repos/${full}/issues/${issue.number}/comments`,
  };
}

/**
 * The response body of one issue, serialized once per distinct field state. A read of the same
 * unchanged issue is the benchmark's hot path (thousands of GETs of one issue), and the bytes cannot
 * change until a field does, so the payload is reused while every field it was built from still
 * matches. The map is weak: an issue that is dropped takes its cached bytes with it.
 */
interface IssuePayloadEntry {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string;
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  owner: string;
  name: string;
  repoLabels: string;
  payload: Buffer;
}

const ISSUE_PAYLOADS = new WeakMap<Issue, IssuePayloadEntry>();

/** A signature of a repository's labels: a label edit changes every issue's payload that names it. */
function repoLabelsSignature(repo: Repo): string {
  if (repo.labels.length === 0) return '';
  let signature = '';
  for (const label of repo.labels) signature += `${label.id}\u0000${label.name}\u0000${label.color}\u0000${label.description}\u0001`;
  return signature;
}

export function issuePayload(repo: Repo, issue: Issue): Buffer {
  const labels = issue.labels.length === 0 ? '' : issue.labels.join('\u0000');
  const repoLabels = repoLabelsSignature(repo);
  const cached = ISSUE_PAYLOADS.get(issue);
  if (
    cached !== undefined &&
    cached.id === issue.id &&
    cached.number === issue.number &&
    cached.title === issue.title &&
    cached.body === issue.body &&
    cached.state === issue.state &&
    cached.labels === labels &&
    cached.comments === issue.comments.length &&
    cached.createdAt === issue.createdAt &&
    cached.updatedAt === issue.updatedAt &&
    cached.closedAt === issue.closedAt &&
    cached.owner === repo.owner &&
    cached.name === repo.name &&
    cached.repoLabels === repoLabels
  ) {
    return cached.payload;
  }
  const payload = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  ISSUE_PAYLOADS.set(issue, {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    comments: issue.comments.length,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    owner: repo.owner,
    name: repo.name,
    repoLabels,
    payload,
  });
  return payload;
}

function refPart(repo: Repo, branch: string): Record<string, unknown> {
  const sha = branchOid(repo, branch) ?? '';
  return {
    ref: branch,
    sha,
    label: `${repo.owner}:${branch}`,
    user: userJson(),
    repo: { id: repo.id, name: repo.name, url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}` },
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: pull.id,
    node_id: `MDExOlB1bGxSZXF1ZXN0${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: refPart(repo, pull.head),
    base: refPart(repo, pull.base),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: true,
    merged_by: pull.merged ? userJson() : null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://forge.invalid/${full}/pull/${pull.number}`,
    url: `https://forge.invalid/api/v3/repos/${full}/pulls/${pull.number}`,
    draft: false,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = readObject(repo, oid);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  const author = /^(.*) <(.*)> (\d+) ([+-]\d+)$/.exec(info.author);
  const date = author ? new Date(Number(author[3]) * 1000).toISOString() : repo.createdAt;
  return {
    sha: oid,
    node_id: `MDY6Q29tbWl0${oid}`,
    commit: {
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree, url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${info.tree}` },
      author: { name: author ? author[1] : OWNER_NAME, email: author ? author[2] : OWNER_EMAIL, date },
      committer: { name: author ? author[1] : OWNER_NAME, email: author ? author[2] : OWNER_EMAIL, date },
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

function blobSha(content: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`, 'utf8'), content])).digest('hex');
}

/** The file entry at `path` on a commit, if the commit's tree holds one. */
function fileAt(repo: Repo, commitOid: string | undefined, path: string): { mode: string; oid: string } | undefined {
  if (commitOid === undefined) return undefined;
  const obj = readObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return undefined;
  const tree = flattenTree(repo, parseCommit(obj.data).tree);
  return tree.get(path);
}

function treeOf(repo: Repo, commitOid: string | undefined): string | null {
  if (commitOid === undefined) return null;
  const obj = readObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Commit one change (set or delete `path`) on `branch`; returns the new commit sha. */
function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  blobOid: string | null,
  message: string,
): string {
  const tip = branchOid(repo, branch);
  const root = treeOf(repo, tip);
  const tree = withPath(repo, root, path, blobOid);
  const commit = makeCommit({
    tree,
    parents: tip === undefined ? [] : [tip],
    message,
    when: nowIso(),
    epoch: Math.floor(Date.now() / 1000) + 0,
  });
  const oid = writeObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.updatedAt = nowIso();
  return oid;
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { perPage, page };
}

/** The next-page Link value for a list route, or null at the end. */
function linkHeader(host: string, href: string, total: number, perPage: number, page: number): Record<string, string> {
  if (page * perPage >= total) return {};
  const next = new URL(href, `http://${host}`);
  next.searchParams.set('page', String(page + 1));
  return { link: `<${next.toString()}>; rel="next"` };
}

function base64(content: Buffer): string {
  return content.toString('base64');
}

export interface RestContext {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  /** The request's Host header, for the routes that build an absolute Link. */
  host: string;
  /** The raw request target (path plus query), so no URL object is built per request. */
  href: string;
  body: Record<string, unknown>;
  res: ServerResponse;
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

export function handleRest(ctx: RestContext): void {
  const { store, method, segments, query, host, href, body, res } = ctx;
  if (segments.length === 0) {
    sendJson(res, 200, {
      current_user_url: 'https://forge.invalid/api/v3/user',
      current_user_authorizations_html_url: 'https://forge.invalid/settings/connections/applications{/client_id}',
      repository_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}',
      user_repositories_url: 'https://forge.invalid/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      rate_limit_url: 'https://forge.invalid/api/v3/rate_limit',
      hub_url: 'https://forge.invalid/api/v3/hub',
    }, { 'x-oauth-scopes': 'repo, read:org, gist, workflow' });
    return;
  }
  if (segments[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '3.14.0',
      hooks: ['127.0.0.1/8'],
      git: ['127.0.0.1/8'],
      ssh_key_fingerprints: {},
    });
    return;
  }
  if (segments[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
        return;
      }
      if (getRepo(store, OWNER, name) !== undefined) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', message: 'name already exists on this account' }] });
        return;
      }
      const repo = createRepo(store, OWNER, name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(res, 201, repoJson(repo), { location: `https://forge.invalid/api/v3/repos/${OWNER}/${name}` });
      return;
    }
    if (method === 'GET') {
      const owned = [...store.repos.values()].filter((repo) => repo.owner === OWNER);
      const { perPage, page } = pageParams(query);
      const slice = owned.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, slice.map(repoJson), linkHeader(host, href, owned.length, perPage, page));
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }
  if (segments[0] === 'users' && segments[2] === 'repos' && method === 'GET') {
    const owner = segments[1]!;
    const owned = [...store.repos.values()].filter((repo) => repo.owner === owner);
    const { perPage, page } = pageParams(query);
    sendJson(res, 200, owned.slice((page - 1) * perPage, page * perPage).map(repoJson));
    return;
  }
  if (segments[0] !== 'repos' || segments.length < 3) {
    notFound(res);
    return;
  }
  const repo = getRepo(store, segments[1]!, segments[2]!);
  if (repo === undefined || repo.owner !== segments[1]) {
    notFound(res);
    return;
  }
  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) repo.name = body.name;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      repo.updatedAt = nowIso();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(store, repo.owner, repo.name);
      sendEmpty(res, 204);
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.slice(11), commit: { sha: repo.refs.get(ref)!, url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(ref)}` }, protected: false }));
      sendJson(res, 200, list);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = branchOid(repo, rest[1]!);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = query.get('sha') ?? repo.defaultBranch;
    const tip = branchOid(repo, shaParam) ?? (repo.objects.has(shaParam) ? shaParam : undefined);
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue = tip === undefined ? [] : [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = readObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(commitJson(repo, oid));
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    sendJson(res, 200, out);
    return;
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    if (!repo.objects.has(rest[1]!)) {
      notFound(res);
      return;
    }
    sendJson(res, 200, commitJson(repo, rest[1]!));
    return;
  }
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (ref === '' || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'Reference update failed', errors: [{ resource: 'GitRef', code: 'custom' }] });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: 'MDM6UmVm', url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`, object: { sha, type: readObject(repo, sha)!.type, url: '' } });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      // /git/refs/heads/<branch>
      const wanted = `${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(wanted) ?? repo.refs.get(`refs/${wanted}`) ?? repo.refs.get(`refs/heads/${wanted}`);
      if (oid === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref: wanted.startsWith('refs/') ? wanted : `refs/${wanted}`, object: { sha: oid, type: 'commit', url: '' } });
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'labels') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] });
        return;
      }
      let label = repo.labels.find((entry) => entry.name === name);
      if (label === undefined) {
        label = { id: store.nextLabelId++, name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.push(label);
      }
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, repo.labels.map(labelJson));
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] });
        return;
      }
      const wanted = Array.isArray(body.labels) ? body.labels.filter((item): item is string => typeof item === 'string') : [];
      const missing = wanted.filter((name) => !repo.labels.some((label) => label.name === name));
      if (missing.length > 0) {
        sendJson(res, 422, { message: `Validation Failed: ${missing.join(', ')} does not exist`, errors: missing.map((name) => ({ resource: 'Issue', field: 'labels', code: 'invalid', value: name })) });
        return;
      }
      const when = nowIso();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssue++,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: wanted,
        comments: [],
        createdAt: when,
        updatedAt: when,
        closedAt: null,
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue), { location: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}` });
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      const keyOf = (issue: Issue): string => (sort === 'updated' ? issue.updatedAt : issue.createdAt);
      list = [...list].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : a.number - b.number));
      if (direction !== 'asc') list.reverse();
      const { perPage, page } = pageParams(query);
      sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(repo, issue)));
      return;
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        notFound(res);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJsonPayload(res, 200, issuePayload(repo, issue));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          issue.state = body.state;
          issue.closedAt = body.state === 'closed' ? nowIso() : null;
        }
        if (Array.isArray(body.labels)) issue.labels = (body.labels as unknown[]).filter((item): item is string => typeof item === 'string');
        issue.updatedAt = nowIso();
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const comment = { id: store.nextCommentId++, body: typeof body.body === 'string' ? body.body : '', createdAt: nowIso() };
          issue.comments.push(comment);
          issue.updatedAt = comment.createdAt;
          sendJson(res, 201, {
            id: comment.id,
            node_id: `MDEyOklzc3VlQ29tbWVud${comment.id}`,
            body: comment.body,
            user: userJson(),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
            url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
          });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: userJson(),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          })));
          return;
        }
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'POST') {
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (branchOid(repo, head) === undefined) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] });
        return;
      }
      if (branchOid(repo, base) === undefined) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] });
        return;
      }
      const when = nowIso();
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextPull++,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
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
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
      list = [...list].sort((a, b) => a.number - b.number);
      const { perPage, page } = pageParams(query);
      sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(repo, pull)));
      return;
    }
    const number = Number(rest[1]);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) {
      notFound(res);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      sendJson(res, 200, pullFiles(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const headOidValue = branchOid(repo, pull.head);
      const baseOidValue = branchOid(repo, pull.base);
      if (headOidValue === undefined || baseOidValue === undefined) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      if (pull.state !== 'open') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      const base = mergeBase(repo, baseOidValue, headOidValue);
      const baseTree = treeOf(repo, base);
      const headTree = treeOf(repo, headOidValue);
      const tipTree = treeOf(repo, baseOidValue);
      if (base === null || baseTree === null || headTree === null || tipTree === null) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      const baseChanges = diffTrees(repo, baseTree, tipTree);
      const headChanges = diffTrees(repo, baseTree, headTree);
      const conflict = [...headChanges.keys()].some((path) => baseChanges.has(path));
      if (conflict) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable: merge conflict' });
        return;
      }
      let tree = tipTree;
      for (const [path, change] of headChanges) tree = withPath(repo, tree, path, change.oid);
      const commitOid = writeObject(repo, 'commit', makeCommit({
        tree,
        parents: [baseOidValue],
        message: `${pull.title} (#${pull.number})`,
        when: nowIso(),
        epoch: Math.floor(Date.now() / 1000),
      }));
      repo.refs.set(`refs/heads/${pull.base}`, commitOid);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = commitOid;
      pull.updatedAt = pull.mergedAt;
      sendJson(res, 200, { sha: commitOid, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const refName = query.get('ref') ?? repo.defaultBranch;
      const commitOid = branchOid(repo, refName) ?? (repo.objects.has(refName) ? refName : undefined);
      if (commitOid === undefined) {
        notFound(res);
        return;
      }
      const tree = treeOf(repo, commitOid);
      if (tree === null) {
        notFound(res);
        return;
      }
      if (path === '') {
        sendJson(res, 200, parseTree(readObject(repo, tree)!.data).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          size: 0,
        })));
        return;
      }
      const flat = flattenTree(repo, tree);
      const file = flat.get(path);
      if (file !== undefined) {
        const blob = readObject(repo, file.oid)!;
        const name = path.split('/').pop() ?? path;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name,
          path,
          content: base64(blob.data),
          sha: file.oid,
          url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          git_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
          html_url: `https://forge.invalid/${repo.owner}/${repo.name}/blob/${refName}/${path}`,
          download_url: null,
        });
        return;
      }
      // a directory?
      const prefix = `${path}/`;
      const entries = [...flat.entries()].filter(([entryPath]) => entryPath.startsWith(prefix));
      if (entries.length === 0) {
        notFound(res);
        return;
      }
      const names = new Set<string>();
      const listed: Record<string, unknown>[] = [];
      for (const [entryPath, entry] of entries) {
        const restPath = entryPath.slice(prefix.length);
        const head = restPath.split('/')[0]!;
        if (names.has(head)) continue;
        names.add(head);
        const isDir = restPath.includes('/');
        const childTree = parseTreeDirectory(repo, tree, `${prefix}${head}`);
        listed.push({
          type: isDir ? 'dir' : 'file',
          name: head,
          path: `${path}/${head}`,
          sha: isDir ? (childTree ?? entry.oid) : entry.oid,
          size: isDir ? 0 : (readObject(repo, entry.oid)?.data.length ?? 0),
        });
      }
      sendJson(res, 200, listed);
      return;
    }
    if (method === 'PUT') {
      const message = typeof body.message === 'string' ? body.message : 'commit';
      if (typeof body.content !== 'string') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'content', code: 'missing_field' }] });
        return;
      }
      const bytes = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const tip = branchOid(repo, branch);
      if (tip === undefined && branch !== repo.defaultBranch) {
        notFound(res);
        return;
      }
      const existing = fileAt(repo, tip, path);
      const providedSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (existing !== undefined && providedSha !== undefined && providedSha !== existing.oid) {
        sendJson(res, 409, { message: 'sha does not match the current file contents' });
        return;
      }
      if (existing !== undefined && providedSha === undefined) {
        sendJson(res, 422, { message: 'Invalid request.\n\n"sha" was not supplied.' });
        return;
      }
      if (existing === undefined && providedSha !== undefined) {
        sendJson(res, 422, { message: 'Invalid request.\n\n"sha" did not match any file' });
        return;
      }
      const blobOid = writeObject(repo, 'blob', bytes);
      const commitOid = commitFileChange(repo, branch, path, blobOid, message);
      sendJson(res, existing === undefined ? 201 : 200, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: bytes.length,
          encoding: 'base64',
          content: base64(bytes),
          type: 'file',
          url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        },
        commit: commitJson(repo, commitOid),
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const tip = branchOid(repo, branch);
      const existing = fileAt(repo, tip, path);
      if (existing === undefined) {
        notFound(res);
        return;
      }
      if (typeof body.sha === 'string' && body.sha !== existing.oid) {
        sendJson(res, 409, { message: 'sha does not match the current file contents' });
        return;
      }
      const commitOid = commitFileChange(repo, branch, path, null, typeof body.message === 'string' ? body.message : 'delete');
      sendJson(res, 200, { content: null, commit: commitJson(repo, commitOid) });
      return;
    }
    notFound(res);
    return;
  }
  notFound(res);
}

function parseTreeDirectory(repo: Repo, root: string, path: string): string | null {
  let current = root;
  for (const segment of path.split('/')) {
    const obj = readObject(repo, current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

/** Changed paths between two trees: path -> the target entry (oid/mode). */
function diffTrees(repo: Repo, fromTree: string, toTree: string): Map<string, { mode: string; oid: string }> {
  const from = flattenTree(repo, fromTree);
  const to = flattenTree(repo, toTree);
  const out = new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of to) {
    const before = from.get(path);
    if (before === undefined || before.oid !== entry.oid) out.set(path, entry);
  }
  for (const [path, entry] of from) {
    if (!to.has(path)) out.set(path, { mode: entry.mode, oid: '' });
  }
  return out;
}

function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headOidValue = branchOid(repo, pull.head);
  const baseOidValue = branchOid(repo, pull.base);
  if (headOidValue === undefined || baseOidValue === undefined) return [];
  const headInfo = readObject(repo, headOidValue);
  const baseInfo = readObject(repo, baseOidValue);
  if (!headInfo || !baseInfo || headInfo.type !== 'commit' || baseInfo.type !== 'commit') return [];
  const base = mergeBase(repo, baseOidValue, headOidValue) ?? baseOidValue;
  const baseTree = treeOf(repo, base);
  const headTree = parseCommit(headInfo.data).tree;
  if (baseTree === null) return [];
  const before = flattenTree(repo, baseTree);
  const after = flattenTree(repo, headTree);
  const out: Record<string, unknown>[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of paths) {
    const from = before.get(path);
    const to = after.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    let additions = 0;
    let deletions = 0;
    if (from === undefined) {
      const blob = readObject(repo, to!.oid);
      additions = blob ? countLines(blob.data) : 1;
    } else if (to === undefined) {
      const blob = readObject(repo, from.oid);
      deletions = blob ? countLines(blob.data) : 1;
    } else {
      const beforeBlob = readObject(repo, from.oid);
      const afterBlob = readObject(repo, to.oid);
      additions = beforeBlob && afterBlob ? diffLineCount(beforeBlob.data, afterBlob.data).additions : 1;
      deletions = beforeBlob && afterBlob ? diffLineCount(beforeBlob.data, afterBlob.data).deletions : 1;
    }
    out.push({
      sha: to?.oid ?? from?.oid ?? '',
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return out;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  return count;
}

function diffLineCount(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const left = before.toString('utf8').split('\n');
  const right = after.toString('utf8').split('\n');
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  let additions = 0;
  let deletions = 0;
  for (const line of right) if (!leftSet.has(line)) additions += 1;
  for (const line of left) if (!rightSet.has(line)) deletions += 1;
  return { additions, deletions };
}

export { headOid, refOid, buildTree };
