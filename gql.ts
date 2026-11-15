// The GraphQL v4 surface: a small executor for the documents gh and github-mcp-server send.
import type { ServerResponse } from 'node:http';
import { getRepo, mergeBase, nowIso, parseCommit, readObject, writeObject, makeCommit, withPath, flattenTree, branchOid, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { sendJson } from './http.ts';

type GqlValue = string | number | boolean | null | { $var: string } | GqlValue[] | { [key: string]: GqlValue };

interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: SelectionNode[];
}

type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; on: string; selections: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

// ---------------------------------------------------------------- parser

class Reader {
  text: string;
  pos = 0;
  constructor(text: string) {
    this.text = text;
  }
  skip(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) return;
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') this.pos += 1;
      else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else return;
    }
  }
  peek(): string {
    this.skip();
    return this.text[this.pos] ?? '';
  }
  eat(expected: string): boolean {
    if (this.peek() === expected) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  name(): string {
    this.skip();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos]!)) this.pos += 1;
    return this.text.slice(start, this.pos);
  }
  stringLiteral(): string {
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length && this.text[this.pos] !== '"') {
      if (this.text[this.pos] === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos];
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc ?? '';
        this.pos += 1;
        continue;
      }
      out += this.text[this.pos];
      this.pos += 1;
    }
    this.pos += 1;
    return out;
  }
  numberLiteral(): number {
    this.skip();
    const start = this.pos;
    while (this.pos < this.text.length && /[-+0-9.eE]/.test(this.text[this.pos]!)) this.pos += 1;
    return Number(this.text.slice(start, this.pos));
  }
}

function parseValue(reader: Reader): GqlValue {
  const ch = reader.peek();
  if (ch === '"') return reader.stringLiteral();
  if (ch === '$') {
    reader.pos += 1;
    return { $var: reader.name() };
  }
  if (ch === '[') {
    reader.pos += 1;
    const items: GqlValue[] = [];
    while (!reader.eat(']')) {
      if (reader.peek() === '') break;
      items.push(parseValue(reader));
    }
    return items;
  }
  if (ch === '{') {
    reader.pos += 1;
    const out: { [key: string]: GqlValue } = {};
    while (!reader.eat('}')) {
      if (reader.peek() === '') break;
      const key = reader.name();
      reader.eat(':');
      out[key] = parseValue(reader);
    }
    return out;
  }
  if (/[-0-9]/.test(ch)) return reader.numberLiteral();
  const word = reader.name();
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (word === 'null') return null;
  return word; // an enum value
}

function parseArgs(reader: Reader): Record<string, GqlValue> {
  const args: Record<string, GqlValue> = {};
  if (!reader.eat('(')) return args;
  while (!reader.eat(')')) {
    if (reader.peek() === '') break;
    const name = reader.name();
    reader.eat(':');
    args[name] = parseValue(reader);
  }
  return args;
}

function parseSelections(reader: Reader): SelectionNode[] {
  const out: SelectionNode[] = [];
  if (!reader.eat('{')) return out;
  for (;;) {
    if (reader.eat('}')) break;
    if (reader.peek() === '') break;
    if (reader.text.startsWith('...', reader.pos)) {
      reader.pos += 3;
      if (reader.name() === 'on') {
        const on = reader.name();
        out.push({ kind: 'fragment', on, selections: parseSelections(reader) });
      } else {
        // a named fragment spread: skip its name, treat as no-op
        reader.name();
      }
      continue;
    }
    const first = reader.name();
    let alias: string | undefined;
    let name = first;
    if (reader.peek() === ':') {
      reader.eat(':');
      alias = first;
      name = reader.name();
    }
    const args = parseArgs(reader);
    while (reader.peek() === '@') {
      reader.pos += 1;
      reader.name();
      parseArgs(reader);
    }
    const selections = reader.peek() === '{' ? parseSelections(reader) : [];
    out.push({ kind: 'field', field: { alias, name, args, selections } });
  }
  return out;
}

function parseDocument(source: string): Operation[] {
  const reader = new Reader(source);
  const operations: Operation[] = [];
  for (;;) {
    reader.skip();
    if (reader.peek() === '') break;
    const keyword = reader.name();
    if (keyword === 'fragment') {
      reader.name();
      reader.name(); // 'on'
      reader.name(); // the type condition
      parseSelections(reader);
      continue;
    }
    if (keyword !== 'query' && keyword !== 'mutation') break;
    let name = reader.name();
    if (name === '') name = '';
    if (reader.peek() === '(') {
      // variable definitions: skip the balanced group
      let depth = 0;
      do {
        const ch = reader.peek();
        reader.pos += 1;
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      } while (depth > 0 && reader.pos < reader.text.length);
    }
    const selections = parseSelections(reader);
    operations.push({ kind: keyword === 'mutation' ? 'mutation' : 'query', name: name === '' ? null : name, selections });
  }
  return operations;
}

// ---------------------------------------------------------------- global ids

function globalId(type: string, id: number): string {
  return Buffer.from(`010:${type}${id}`, 'utf8').toString('base64');
}

function parseGlobalId(value: string): { type: string; id: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^010:([A-Za-z]+)(-?\d+)$/.exec(decoded);
  if (!match) return null;
  return { type: match[1]!, id: Number(match[2]) };
}

// ---------------------------------------------------------------- values

interface Value {
  __typename?: string;
  __custom?: Record<string, (args: Record<string, GqlValue>) => unknown>;
  [key: string]: unknown;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueValue(repo: Repo, issue: Issue): Value {
  return {
    __typename: 'Issue',
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
    createdAt: issue.createdAt,
    labels: { nodes: issue.labels.map((name) => ({ name })), totalCount: issue.labels.length },
  };
}

function pullValue(repo: Repo, pull: Pull): Value {
  const head = branchOid(repo, pull.head);
  const base = branchOid(repo, pull.base);
  let mergeable = 'MERGEABLE';
  if (head !== undefined && base !== undefined) {
    const base0 = mergeBase(repo, base, head);
    if (base0 === null) mergeable = 'CONFLICTING';
  }
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    title: pull.title,
    body: pull.body,
    mergeable,
    __custom: {
      files: () => ({ nodes: pullFilesOf(repo, pull).map((path) => ({ path })), totalCount: pullFilesOf(repo, pull).length }),
      commits: () => ({ nodes: [] }),
    },
  };
}

function pullFilesOf(repo: Repo, pull: Pull): string[] {
  const head = branchOid(repo, pull.head);
  const base = branchOid(repo, pull.base);
  if (head === undefined || base === undefined) return [];
  const mb = mergeBase(repo, base, head) ?? base;
  const baseObj = readObject(repo, mb);
  const headObj = readObject(repo, head);
  if (!baseObj || !headObj || baseObj.type !== 'commit' || headObj.type !== 'commit') return [];
  const before = flattenTree(repo, parseCommit(baseObj.data).tree);
  const after = flattenTree(repo, parseCommit(headObj.data).tree);
  const paths: string[] = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (old === undefined || old.oid !== entry.oid) paths.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) paths.push(path);
  return paths;
}

function repoValue(repo: Repo): Value {
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: globalId('User', 1000) },
    defaultBranchRef: repo.refs.get(`refs/heads/${repo.defaultBranch}`) !== undefined ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.isPrivate,
    description: repo.description,
    __custom: {
      issue: (args) => {
        const number = Number(args.number);
        const found = repo.issues.find((issue) => issue.number === number);
        return found ? issueValue(repo, found) : null;
      },
      issues: (args) => {
        const states = Array.isArray(args.states) ? args.states.map(String) : null;
        let list = repo.issues.filter((issue) => (states === null ? true : states.includes(issueState(issue))));
        const orderBy = args.orderBy as Record<string, GqlValue> | undefined;
        const descending = !orderBy || String(orderBy.direction ?? 'DESC') !== 'ASC';
        list = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number));
        if (descending) list.reverse();
        const first = typeof args.first === 'number' ? args.first : 30;
        const after = typeof args.after === 'string' ? Number(Buffer.from(args.after, 'base64').toString('utf8')) || 0 : 0;
        const startIndex = after > 0 ? list.findIndex((issue) => issue.number === after) + 1 : 0;
        const slice = list.slice(startIndex, startIndex + first);
        const hasNextPage = startIndex + first < list.length;
        return {
          nodes: slice.map((issue) => issueValue(repo, issue)),
          totalCount: list.length,
          pageInfo: {
            hasNextPage,
            endCursor: slice.length > 0 ? Buffer.from(String(slice[slice.length - 1]!.number), 'utf8').toString('base64') : null,
          },
        };
      },
      pullRequests: (args) => {
        const first = typeof args.first === 'number' ? args.first : 30;
        const list = [...repo.pulls].sort((a, b) => a.number - b.number).slice(0, first);
        return { nodes: list.map((pull) => pullValue(repo, pull)), totalCount: repo.pulls.length, pageInfo: { hasNextPage: false, endCursor: null } };
      },
      pullRequest: (args) => {
        const number = Number(args.number);
        const found = repo.pulls.find((pull) => pull.number === number);
        return found ? pullValue(repo, found) : null;
      },
      labels: () => ({ nodes: repo.labels.map((label) => ({ name: label.name, color: label.color })) }),
    },
  };
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'labels', 'comments', 'author', 'closed'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'commits', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'labels'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeValue(name: string): Value | null {
  const fields = TYPE_FIELDS[name];
  const enums = TYPE_ENUMS[name];
  if (fields === undefined && enums === undefined) return null;
  return {
    __typename: '__Type',
    kind: enums !== undefined ? 'ENUM' : 'OBJECT',
    name,
    description: `${name} type`,
    fields: fields === undefined ? null : fields.map((field) => ({
      name: field,
      description: `the ${field} field`,
      args: [],
      type: { kind: 'SCALAR', name: 'String', ofType: null },
      isDeprecated: false,
      deprecationReason: null,
    })),
    enumValues: enums === undefined ? null : enums.map((value) => ({ name: value, description: value, isDeprecated: false, deprecationReason: null })),
    possibleTypes: null,
    interfaces: [],
  };
}

// ---------------------------------------------------------------- execution

function resolveArgs(args: Record<string, GqlValue>, variables: Record<string, unknown>): Record<string, GqlValue> {
  const resolved: Record<string, GqlValue> = {};
  for (const [key, value] of Object.entries(args)) resolved[key] = resolveValue(value, variables);
  return resolved;
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): GqlValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (typeof value === 'object' && value !== null) {
    if ('$var' in value && typeof (value as { $var: unknown }).$var === 'string') {
      const name = (value as { $var: string }).$var;
      const held = variables[name];
      return (held === undefined ? null : (held as GqlValue)) ?? null;
    }
    const out: { [key: string]: GqlValue } = {};
    for (const [key, item] of Object.entries(value as { [key: string]: GqlValue })) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

interface ExecError {
  message: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
}

function resolveSelections(
  value: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  errors: ExecError[],
  path: Array<string | number>,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveSelections(item, selections, variables, errors, [...path, index])) as unknown as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  const container = value as Value;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const typename = container.__typename;
      if (typename === undefined || typename === selection.on) {
        const nested = resolveSelections(container, selection.selections, variables, errors, path);
        if (nested !== null) Object.assign(out, nested);
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const args = resolveArgs(field.args, variables);
    let resolved: unknown;
    const custom = container.__custom?.[field.name];
    if (custom !== undefined) resolved = custom(args);
    else if (Object.prototype.hasOwnProperty.call(container, field.name)) resolved = container[field.name];
    else {
      const typename = container.__typename ?? 'Object';
      errors.push({ message: `Field '${field.name}' doesn't exist on type '${typename}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (field.selections.length === 0) {
      out[key] = resolved === undefined ? null : resolved;
      continue;
    }
    out[key] = resolveSelections(resolved, field.selections, variables, errors, [...path, key]);
  }
  return out;
}

function newIssue(store: Store, repo: Repo, title: string, body: string): Issue {
  const when = nowIso();
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    createdAt: when,
    updatedAt: when,
    closedAt: null,
  };
  repo.issues.push(issue);
  return issue;
}

export function findRepoByGlobalId(store: Store, value: string): Repo | undefined {
  const parsed = parseGlobalId(value);
  if (parsed === null || parsed.type !== 'Repository') return undefined;
  for (const repo of store.repos.values()) if (repo.id === parsed.id) return repo;
  return undefined;
}

function runOperation(store: Store, operation: Operation, variables: Record<string, unknown>, errors: ExecError[]): Record<string, unknown> {
  const root: Value = {
    __typename: 'Query',
    __custom: {
      viewer: () => ({ __typename: 'User', login: 'adaiversen', id: globalId('User', 1000) }),
      repository: (args) => {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = getRepo(store, owner, name);
        return repo ? repoValue(repo) : null;
      },
      node: (args) => {
        const id = String(args.id ?? '');
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.type === 'Repository') {
          for (const repo of store.repos.values()) if (repo.id === parsed.id) return repoValue(repo);
          return null;
        }
        if (parsed.type === 'Issue') {
          for (const repo of store.repos.values()) {
            const issue = repo.issues.find((entry) => entry.id === parsed.id);
            if (issue) return issueValue(repo, issue);
          }
          return null;
        }
        return null;
      },
      __type: (args) => typeValue(String(args.name ?? '')),
      createIssue: (args) => {
        const input = (args.input ?? {}) as Record<string, GqlValue>;
        const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
        if (repo === undefined) return { issue: null };
        const issue = newIssue(store, repo, String(input.title ?? ''), String(input.body ?? ''));
        return { issue: { number: issue.number, id: globalId('Issue', issue.id), state: 'OPEN', title: issue.title, body: issue.body } };
      },
      closeIssue: (args) => {
        const input = (args.input ?? {}) as Record<string, GqlValue>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        if (parsed === null) return { issue: null };
        for (const repo of store.repos.values()) {
          const issue = repo.issues.find((entry) => entry.id === parsed.id);
          if (issue !== undefined) {
            issue.state = 'closed';
            issue.closedAt = nowIso();
            issue.updatedAt = issue.closedAt;
            return { issue: { number: issue.number, id: globalId('Issue', issue.id), state: 'CLOSED' } };
          }
        }
        return { issue: null };
      },
      addComment: (args) => {
        const input = (args.input ?? {}) as Record<string, GqlValue>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (parsed === null) return { commentEdge: { node: null } };
        for (const repo of store.repos.values()) {
          const issue = repo.issues.find((entry) => entry.id === parsed.id);
          if (issue !== undefined) {
            const comment = { id: store.nextCommentId++, body: String(input.body ?? ''), createdAt: nowIso() };
            issue.comments.push(comment);
            issue.updatedAt = comment.createdAt;
            return { commentEdge: { node: { id: globalId('IssueComment', comment.id), body: comment.body } } };
          }
        }
        return { commentEdge: { node: null } };
      },
      createPullRequest: (args) => {
        const input = (args.input ?? {}) as Record<string, GqlValue>;
        const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
        if (repo === undefined) return { pullRequest: null };
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? repo.defaultBranch);
        const when = nowIso();
        const pull: Pull = {
          id: store.nextPullId++,
          number: repo.nextPull++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
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
        return { pullRequest: { number: pull.number, id: globalId('PullRequest', pull.id), state: 'OPEN', headRefName: head, baseRefName: base } };
      },
      mergePullRequest: (args) => {
        const input = (args.input ?? {}) as Record<string, GqlValue>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        if (parsed === null) return { pullRequest: null };
        for (const repo of store.repos.values()) {
          const pull = repo.pulls.find((entry) => entry.id === parsed.id);
          if (pull !== undefined) {
            const merged = squashMerge(repo, pull);
            return { pullRequest: { number: pull.number, merged: merged, state: merged ? 'MERGED' : 'OPEN' } };
          }
        }
        return { pullRequest: null };
      },
    },
  };
  return resolveSelections(root, operation.selections, variables, errors, []) ?? {};
}

/** A squash merge of `pull` into its base: the commit lands on the base branch. */
export function squashMerge(repo: Repo, pull: Pull): boolean {
  const head = branchOid(repo, pull.head);
  const base = branchOid(repo, pull.base);
  if (head === undefined || base === undefined) return false;
  const mb = mergeBase(repo, base, head);
  const baseObj = readObject(repo, base);
  const headObj = readObject(repo, head);
  if (mb === null || !baseObj || !headObj || baseObj.type !== 'commit' || headObj.type !== 'commit') return false;
  const mbObj = readObject(repo, mb);
  if (!mbObj || mbObj.type !== 'commit') return false;
  const mbTree = parseCommit(mbObj.data).tree;
  const baseTree = parseCommit(baseObj.data).tree;
  const headTree = parseCommit(headObj.data).tree;
  const baseChanges = flattenTree(repo, mbTree);
  const tipChanges = flattenTree(repo, baseTree);
  const headChanges = flattenTree(repo, headTree);
  let tree = baseTree;
  for (const [path, entry] of headChanges) {
    const before = baseChanges.get(path);
    if (before !== undefined && before.oid === entry.oid) continue;
    const onBase = tipChanges.get(path);
    if (before !== undefined && onBase !== undefined && onBase.oid !== before.oid) return false; // conflict
    if (before !== undefined && onBase === undefined) return false; // base deleted it
    tree = withPath(repo, tree, path, entry.oid);
  }
  for (const path of baseChanges.keys()) if (!headChanges.has(path)) continue;
  const commit = writeObject(repo, 'commit', makeCommit({
    tree,
    parents: [base],
    message: `${pull.title} (#${pull.number})`,
    when: nowIso(),
    epoch: Math.floor(Date.now() / 1000),
  }));
  repo.refs.set(`refs/heads/${pull.base}`, commit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = commit;
  pull.updatedAt = pull.mergedAt;
  return true;
}

export interface GraphQLContext {
  store: Store;
  body: unknown;
  res: ServerResponse;
  authed: boolean;
}

export function handleGraphQL(ctx: GraphQLContext): void {
  const { store, body, res, authed } = ctx;
  if (!authed) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/graphql' });
    return;
  }
  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const batched = Array.isArray(body);
  const documents = batched ? (body as unknown[]) : [body];
  const answers = documents.map((document) => {
    if (typeof document !== 'object' || document === null) return { errors: [{ message: 'a request must be a JSON object' }] };
    const record = document as Record<string, unknown>;
    const source = typeof record.query === 'string' ? record.query : '';
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
    const errors: ExecError[] = [];
    let operations: Operation[] = [];
    try {
      operations = parseDocument(source);
    } catch {
      return { errors: [{ message: 'failed to parse the document' }] };
    }
    const data: Record<string, unknown> = {};
    for (const operation of operations) {
      const result = runOperation(store, operation, variables, errors);
      Object.assign(data, result);
    }
    return errors.length > 0 ? { data, errors } : { data };
  });
  sendJson(res, 200, batched ? answers : answers[0]);
}
