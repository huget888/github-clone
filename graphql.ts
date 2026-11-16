// graphql.ts — GitHub GraphQL v4, for the documents gh and github-mcp-server send.
//
// A small hand-written executor (tokenizer, parser, resolver) for exactly the
// documents the suite sends: repository/issue/pull-request reads, cursor
// pagination, the node query, the five mutations, __type introspection and
// batched operations. A query naming an unknown field answers HTTP 200 with an
// errors array naming it, never a 400. Global ids are opaque (base64url), never
// the plain database id or number.

import {
  VIEWER,
  findUser,
  gid,
  parseGid,
  parseCommit,
  mergeBaseOf,
  diffTrees,
  pullMergeable,
  mergePull,
  type HandlerResult,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- the parser

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '"': '"', '\\': '\\' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if ((input[j] === 'e' || input[j] === 'E') && /[0-9+-]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in query`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
}

interface FragmentSpreadSelection {
  kind: 'spread';
  name: string;
}

interface InlineFragmentSelection {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSpreadSelection | InlineFragmentSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''}, got ${token.value}`);
    }
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        throw new Error(`unexpected token ${token.value} at document level`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const type = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: string[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'punct' && this.peek().value === '$') {
          this.next();
          variables.push(this.expectName());
          // Skip the type (a name, possibly with ! or [ ]).
          while (this.peek().kind === 'name' || (this.peek().kind === 'punct' && '![ ]'.includes(this.peek().value))) this.next();
          if (this.peek().kind === 'punct' && this.peek().value === '=') {
            this.next();
            this.parseValue();
          }
        } else {
          this.next();
        }
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    return { type, name, variables, selections: this.parseSelectionSet() };
  }

  private parseFragment(): FragmentDef {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.skipDirectives();
    return { name, typeCondition, selections: this.parseSelectionSet() };
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((child) => evalValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- the executor

interface GqlObj {
  __typename: string;
  data: unknown;
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string; path: (string | number)[] }>;
}

type Resolver = (obj: GqlObj, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {};

function isGqlObj(value: unknown): value is GqlObj {
  return typeof value === 'object' && value !== null && '__typename' in value && 'data' in value;
}

function executeSelectionSet(obj: GqlObj, selections: readonly Selection[], ctx: Ctx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== obj.__typename && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(obj, fragment.selections, ctx, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelectionSet(obj, selection.selections, ctx, path));
      continue;
    }
    const fieldPath = [...path, selection.alias];
    const args: Record<string, unknown> = {};
    for (const [key, node] of Object.entries(selection.args)) args[key] = evalValue(node, ctx.variables);
    let value: unknown;
    if (selection.name === '__typename') {
      value = obj.__typename;
    } else {
      const fields = RESOLVERS[obj.__typename];
      const resolver = fields?.[selection.name];
      if (resolver === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${obj.__typename}".`, path: fieldPath });
        out[selection.alias] = null;
        continue;
      }
      try {
        value = resolver(obj, args, ctx);
      } catch (err) {
        ctx.errors.push({ message: (err as Error).message, path: fieldPath });
        out[selection.alias] = null;
        continue;
      }
    }
    if (selection.selections.length === 0) {
      out[selection.alias] = isGqlObj(value) ? null : value;
      continue;
    }
    if (value === null || value === undefined) {
      out[selection.alias] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[selection.alias] = value.map((entry, index) =>
        isGqlObj(entry) ? executeSelectionSet(entry, selection.selections, ctx, [...fieldPath, index]) : entry,
      );
      continue;
    }
    if (isGqlObj(value)) {
      out[selection.alias] = executeSelectionSet(value, selection.selections, ctx, fieldPath);
      continue;
    }
    ctx.errors.push({ message: `Field "${selection.name}" of type "${obj.__typename}" must have a selection of subfields.`, path: fieldPath });
    out[selection.alias] = null;
  }
  return out;
}

// ---------------------------------------------------------------- cursors

function encodeCursor(index: number): string {
  return Buffer.from(`c:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('c:')) return -1;
    const index = Number.parseInt(text.slice(2), 10);
    return Number.isInteger(index) ? index : -1;
  } catch {
    return -1;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

/** A Relay-style connection over an ordered list. */
function connection<T>(items: readonly T[], args: ConnectionArgs, wrap: (item: T) => GqlObj): GqlObj {
  const after = decodeCursor(args.after);
  const before = decodeCursor(args.before);
  let start = after + 1;
  let end = before < 0 ? items.length : before;
  if (typeof args.first === 'number') end = Math.min(end, start + Math.max(0, args.first));
  if (typeof args.last === 'number') start = Math.max(start, end - Math.max(0, args.last));
  start = Math.max(0, Math.min(start, items.length));
  end = Math.max(start, Math.min(end, items.length));
  const page = items.slice(start, end);
  return {
    __typename: 'Connection',
    data: {
      nodes: page.map(wrap),
      totalCount: items.length,
      pageInfo: {
        hasNextPage: end < items.length,
        hasPreviousPage: start > 0,
        startCursor: page.length === 0 ? null : encodeCursor(start),
        endCursor: page.length === 0 ? null : encodeCursor(end - 1),
      },
    },
  };
}

function pageInfoResolver(obj: GqlObj): GqlObj {
  return { __typename: 'PageInfo', data: (obj.data as { pageInfo: unknown }).pageInfo };
}

// ---------------------------------------------------------------- object wrappers

function repoObj(repo: Repo): GqlObj {
  return { __typename: 'Repository', data: { repo } };
}

function issueObj(repo: Repo, issue: Issue): GqlObj {
  return { __typename: 'Issue', data: { repo, issue } };
}

function pullObj(repo: Repo, pull: Pull): GqlObj {
  return { __typename: 'PullRequest', data: { repo, pull } };
}

function userObj(user: { login: string; id: number; name: string; email: string }): GqlObj {
  return { __typename: 'User', data: user };
}

function refObj(name: string): GqlObj {
  return { __typename: 'Ref', data: { name } };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------- resolvers

RESOLVERS.Query = {
  viewer: () => userObj(VIEWER),
  repository: (_obj, args, ctx) => {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = ctx.store.getRepo(owner, name);
    return repo === undefined ? null : repoObj(repo);
  },
  node: (_obj, args, ctx) => {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const parsed = parseGid(id);
    if (parsed === null) return null;
    if (parsed.kind === 'repo') {
      const repo = ctx.store.repoByGid(id);
      return repo === undefined ? null : repoObj(repo);
    }
    if (parsed.kind === 'issue') {
      const found = ctx.store.issueByGid(id);
      return found === undefined ? null : issueObj(found.repo, found.issue);
    }
    if (parsed.kind === 'pr') {
      const found = ctx.store.pullByGid(id);
      return found === undefined ? null : pullObj(found.repo, found.pull);
    }
    return null;
  },
  __type: (_obj, args) => {
    const name = args.name;
    if (typeof name !== 'string') return null;
    return introspectionType(name);
  },
  __schema: () => ({ __typename: '__Schema', data: {} }),
};

RESOLVERS.Mutation = {
  createIssue: (_obj, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = typeof input.repositoryId === 'string' ? ctx.store.repoByGid(input.repositoryId) : undefined;
    if (repo === undefined) throw new Error('repository not found');
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new Error('title is required');
    const now = ctx.store.clock.nowIso();
    const issue: Issue = {
      id: ctx.store.nextIssueNumericId(),
      number: repo.nextIssue++,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      user: VIEWER,
      created_at: now,
      updated_at: now,
      closed_at: null,
      comments: [],
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', data: { issue: issueObj(repo, issue) } };
  },
  closeIssue: (_obj, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = typeof input.issueId === 'string' ? ctx.store.issueByGid(input.issueId) : undefined;
    if (found === undefined) throw new Error('issue not found');
    found.issue.state = 'closed';
    found.issue.closed_at = ctx.store.clock.nowIso();
    found.issue.updated_at = found.issue.closed_at;
    return { __typename: 'CloseIssuePayload', data: { issue: issueObj(found.repo, found.issue) } };
  },
  createPullRequest: (_obj, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = typeof input.repositoryId === 'string' ? ctx.store.repoByGid(input.repositoryId) : undefined;
    if (repo === undefined) throw new Error('repository not found');
    const head = input.headRefName;
    const base = input.baseRefName;
    const title = input.title;
    if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string' || title === '') {
      throw new Error('headRefName, baseRefName and title are required');
    }
    if (repo.branchTip(head) === null) throw new Error(`head branch ${head} does not exist`);
    if (repo.branchTip(base) === null) throw new Error(`base branch ${base} does not exist`);
    const now = ctx.store.clock.nowIso();
    const pull: Pull = {
      id: ctx.store.nextPullNumericId(),
      number: repo.nextPull++,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      user: VIEWER,
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    repo.pulls.push(pull);
    return { __typename: 'CreatePullRequestPayload', data: { pullRequest: pullObj(repo, pull) } };
  },
  mergePullRequest: (_obj, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = typeof input.pullRequestId === 'string' ? ctx.store.pullByGid(input.pullRequestId) : undefined;
    if (found === undefined) throw new Error('pull request not found');
    const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
    const merged = mergePull(ctx.store, found.repo, found.pull, method);
    if (!merged.ok) throw new Error(merged.reason);
    return { __typename: 'MergePullRequestPayload', data: { pullRequest: pullObj(found.repo, found.pull) } };
  },
  addComment: (_obj, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = typeof input.subjectId === 'string' ? ctx.store.issueByGid(input.subjectId) : undefined;
    if (found === undefined) throw new Error('issue not found');
    const body = input.body;
    if (typeof body !== 'string' || body === '') throw new Error('body is required');
    const now = ctx.store.clock.nowIso();
    const comment = { id: ctx.store.nextCommentNumericId(), body, user: VIEWER, created_at: now, updated_at: now };
    found.issue.comments.push(comment);
    found.issue.updated_at = now;
    const node = {
      __typename: 'IssueComment',
      data: { repo: found.repo, issue: found.issue, comment },
    };
    return { __typename: 'AddCommentPayload', data: { commentEdge: { __typename: 'IssueCommentEdge', data: { node } } } };
  },
};

RESOLVERS.User = {
  login: (obj) => (obj.data as { login: string }).login,
  id: (obj) => gid('user', (obj.data as { login: string }).login),
  name: (obj) => (obj.data as { name: string }).name,
  email: (obj) => (obj.data as { email: string }).email,
  url: (obj) => `https://github.com/${(obj.data as { login: string }).login}`,
};

RESOLVERS.Repository = {
  id: (obj) => gid('repo', (obj.data as { repo: Repo }).repo.fullName),
  databaseId: (obj) => (obj.data as { repo: Repo }).repo.id,
  name: (obj) => (obj.data as { repo: Repo }).repo.name,
  nameWithOwner: (obj) => (obj.data as { repo: Repo }).repo.fullName,
  owner: (obj) => {
    const repo = (obj.data as { repo: Repo }).repo;
    return userObj(findUser(repo.owner) ?? VIEWER);
  },
  defaultBranchRef: (obj) => refObj((obj.data as { repo: Repo }).repo.defaultBranch),
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  url: (obj) => `https://github.com/${(obj.data as { repo: Repo }).repo.fullName}`,
  description: (obj) => (obj.data as { repo: Repo }).repo.description,
  createdAt: (obj) => (obj.data as { repo: Repo }).repo.createdAt,
  updatedAt: (obj) => (obj.data as { repo: Repo }).repo.updatedAt,
  isPrivate: (obj) => (obj.data as { repo: Repo }).repo.isPrivate,
  issue: (obj, args) => {
    const { repo } = obj.data as { repo: Repo };
    const number = args.number;
    if (typeof number !== 'number') return null;
    const issue = repo.issues.find((entry) => entry.number === number);
    return issue === undefined ? null : issueObj(repo, issue);
  },
  issues: (obj, args) => {
    const { repo } = obj.data as { repo: Repo };
    let issues = [...repo.issues];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state)));
      issues = issues.filter((issue) => wanted.has(issueState(issue)));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const direction = orderBy?.direction === 'ASC' ? 1 : -1;
    const field = orderBy?.field ?? 'CREATED_AT';
    const key = (issue: Issue): number | string => {
      if (field === 'UPDATED_AT') return issue.updated_at;
      if (field === 'COMMENTS') return issue.comments.length;
      return issue.created_at;
    };
    issues.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const cmp = ka < kb ? -1 : ka > kb ? 1 : a.number - b.number;
      return cmp * direction;
    });
    const conn = connection(issues, args as ConnectionArgs, (issue) => issueObj(repo, issue));
    conn.__typename = 'IssueConnection';
    return conn;
  },
  pullRequests: (obj, args) => {
    const { repo } = obj.data as { repo: Repo };
    let pulls = [...repo.pulls];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state)));
      pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
    } else {
      pulls = pulls.filter((pull) => pull.state === 'open');
    }
    pulls.sort((a, b) => b.number - a.number);
    const conn = connection(pulls, args as ConnectionArgs, (pull) => pullObj(repo, pull));
    conn.__typename = 'PullRequestConnection';
    return conn;
  },
  pullRequest: (obj, args) => {
    const { repo } = obj.data as { repo: Repo };
    const number = args.number;
    if (typeof number !== 'number') return null;
    const pull = repo.pulls.find((entry) => entry.number === number);
    return pull === undefined ? null : pullObj(repo, pull);
  },
};

RESOLVERS.Issue = {
  id: (obj) => {
    const { repo, issue } = obj.data as { repo: Repo; issue: Issue };
    return gid('issue', `${repo.fullName}#${issue.number}`);
  },
  number: (obj) => (obj.data as { issue: Issue }).issue.number,
  title: (obj) => (obj.data as { issue: Issue }).issue.title,
  state: (obj) => issueState((obj.data as { issue: Issue }).issue),
  body: (obj) => (obj.data as { issue: Issue }).issue.body,
  createdAt: (obj) => (obj.data as { issue: Issue }).issue.created_at,
  updatedAt: (obj) => (obj.data as { issue: Issue }).issue.updated_at,
  closedAt: (obj) => (obj.data as { issue: Issue }).issue.closed_at,
  url: (obj) => {
    const { repo, issue } = obj.data as { repo: Repo; issue: Issue };
    return `https://github.com/${repo.fullName}/issues/${issue.number}`;
  },
  author: (obj) => userObj((obj.data as { issue: Issue }).issue.user),
  repository: (obj) => repoObj((obj.data as { repo: Repo }).repo),
  comments: (obj, args) => {
    const { repo, issue } = obj.data as { repo: Repo; issue: Issue };
    const conn = connection(issue.comments, args as ConnectionArgs, (comment) => ({
      __typename: 'IssueComment',
      data: { repo, issue, comment },
    }));
    conn.__typename = 'IssueCommentConnection';
    return conn;
  },
};

RESOLVERS.PullRequest = {
  id: (obj) => {
    const { repo, pull } = obj.data as { repo: Repo; pull: Pull };
    return gid('pr', `${repo.fullName}#${pull.number}`);
  },
  number: (obj) => (obj.data as { pull: Pull }).pull.number,
  title: (obj) => (obj.data as { pull: Pull }).pull.title,
  body: (obj) => (obj.data as { pull: Pull }).pull.body,
  state: (obj) => pullState((obj.data as { pull: Pull }).pull),
  merged: (obj) => (obj.data as { pull: Pull }).pull.merged,
  mergeable: (obj) => {
    const { repo, pull } = obj.data as { repo: Repo; pull: Pull };
    return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
  },
  headRefName: (obj) => (obj.data as { pull: Pull }).pull.headRef,
  baseRefName: (obj) => (obj.data as { pull: Pull }).pull.baseRef,
  headRef: (obj) => refObj((obj.data as { pull: Pull }).pull.headRef),
  baseRef: (obj) => refObj((obj.data as { pull: Pull }).pull.baseRef),
  createdAt: (obj) => (obj.data as { pull: Pull }).pull.created_at,
  updatedAt: (obj) => (obj.data as { pull: Pull }).pull.updated_at,
  closedAt: (obj) => (obj.data as { pull: Pull }).pull.closed_at,
  mergedAt: (obj) => (obj.data as { pull: Pull }).pull.merged_at,
  author: (obj) => userObj((obj.data as { pull: Pull }).pull.user),
  repository: (obj) => repoObj((obj.data as { repo: Repo }).repo),
  files: (obj, args) => {
    const { repo, pull } = obj.data as { repo: Repo; pull: Pull };
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === null || baseTip === null) return connection([], args as ConnectionArgs, (file) => file);
    const base = mergeBaseOf(repo, headTip, baseTip) ?? baseTip;
    const baseTree = parseCommit(repo.getObject(base)!.data).tree;
    const headTree = parseCommit(repo.getObject(headTip)!.data).tree;
    const files = diffTrees(repo, baseTree, headTree);
    const conn = connection(files, args as ConnectionArgs, (file) => ({
      __typename: 'PullRequestFile',
      data: file,
    }));
    conn.__typename = 'PullRequestFileConnection';
    return conn;
  },
};

RESOLVERS.Ref = {
  name: (obj) => (obj.data as { name: string }).name,
};

RESOLVERS.IssueConnection = {
  nodes: (obj) => (obj.data as { nodes: GqlObj[] }).nodes,
  totalCount: (obj) => (obj.data as { totalCount: number }).totalCount,
  pageInfo: pageInfoResolver,
};

RESOLVERS.PullRequestConnection = {
  nodes: (obj) => (obj.data as { nodes: GqlObj[] }).nodes,
  totalCount: (obj) => (obj.data as { totalCount: number }).totalCount,
  pageInfo: pageInfoResolver,
};

RESOLVERS.PullRequestFileConnection = {
  nodes: (obj) => (obj.data as { nodes: GqlObj[] }).nodes,
  totalCount: (obj) => (obj.data as { totalCount: number }).totalCount,
  pageInfo: pageInfoResolver,
};

RESOLVERS.IssueCommentConnection = {
  nodes: (obj) => (obj.data as { nodes: GqlObj[] }).nodes,
  totalCount: (obj) => (obj.data as { totalCount: number }).totalCount,
  pageInfo: pageInfoResolver,
};

RESOLVERS.Connection = RESOLVERS.IssueConnection;

RESOLVERS.PageInfo = {
  hasNextPage: (obj) => (obj.data as { hasNextPage: boolean }).hasNextPage,
  hasPreviousPage: (obj) => (obj.data as { hasPreviousPage: boolean }).hasPreviousPage,
  startCursor: (obj) => (obj.data as { startCursor: string | null }).startCursor,
  endCursor: (obj) => (obj.data as { endCursor: string | null }).endCursor,
};

RESOLVERS.PullRequestFile = {
  path: (obj) => (obj.data as { filename: string }).filename,
  additions: (obj) => (obj.data as { additions: number }).additions,
  deletions: (obj) => (obj.data as { deletions: number }).deletions,
  status: (obj) => (obj.data as { status: string }).status,
};

RESOLVERS.CreateIssuePayload = {
  issue: (obj) => (obj.data as { issue: GqlObj }).issue,
  clientMutationId: () => null,
};

RESOLVERS.CloseIssuePayload = {
  issue: (obj) => (obj.data as { issue: GqlObj }).issue,
  clientMutationId: () => null,
};

RESOLVERS.CreatePullRequestPayload = {
  pullRequest: (obj) => (obj.data as { pullRequest: GqlObj }).pullRequest,
  clientMutationId: () => null,
};

RESOLVERS.MergePullRequestPayload = {
  pullRequest: (obj) => (obj.data as { pullRequest: GqlObj }).pullRequest,
  clientMutationId: () => null,
};

RESOLVERS.AddCommentPayload = {
  commentEdge: (obj) => (obj.data as { commentEdge: GqlObj }).commentEdge,
  clientMutationId: () => null,
};

RESOLVERS.IssueCommentEdge = {
  node: (obj) => (obj.data as { node: GqlObj }).node,
};

RESOLVERS.IssueComment = {
  id: (obj) => {
    const { repo, issue, comment } = obj.data as { repo: Repo; issue: Issue; comment: { id: number } };
    return gid('comment', `${repo.fullName}#${issue.number}:${comment.id}`);
  },
  body: (obj) => (obj.data as { comment: { body: string } }).comment.body,
  author: (obj) => userObj((obj.data as { comment: { user: { login: string; id: number; name: string; email: string } } }).comment.user),
  createdAt: (obj) => (obj.data as { comment: { created_at: string } }).comment.created_at,
  url: (obj) => {
    const { repo, issue } = obj.data as { repo: Repo; issue: Issue };
    return `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${(obj.data as { comment: { id: number } }).comment.id}`;
  },
};

RESOLVERS.__Type = {
  name: (obj) => (obj.data as { name: string }).name,
  kind: (obj) => (obj.data as { kind: string }).kind,
  description: () => null,
  fields: (obj) => {
    const data = obj.data as { fields?: string[] };
    if (data.fields === undefined) return null;
    return data.fields.map((name) => ({ __typename: '__Field', data: { name } }));
  },
  enumValues: (obj) => {
    const data = obj.data as { enumValues?: string[] };
    if (data.enumValues === undefined) return null;
    return data.enumValues.map((name) => ({ __typename: '__EnumValue', data: { name } }));
  },
};

RESOLVERS.__Field = {
  name: (obj) => (obj.data as { name: string }).name,
  description: () => null,
};

RESOLVERS.__EnumValue = {
  name: (obj) => (obj.data as { name: string }).name,
  description: () => null,
};

RESOLVERS.__Schema = {
  queryType: () => ({ __typename: '__Type', data: { name: 'Query', kind: 'OBJECT', fields: Object.keys(RESOLVERS.Query) } }),
  mutationType: () => ({ __typename: '__Type', data: { name: 'Mutation', kind: 'OBJECT', fields: Object.keys(RESOLVERS.Mutation) } }),
  subscriptionType: () => null,
  types: () => [],
};

// ---------------------------------------------------------------- introspection

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'PROJECT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function introspectionType(name: string): GqlObj | null {
  if (ENUM_VALUES[name] !== undefined) {
    return { __typename: '__Type', data: { name, kind: 'ENUM', enumValues: ENUM_VALUES[name] } };
  }
  const fields = RESOLVERS[name];
  if (fields !== undefined) {
    return { __typename: '__Type', data: { name, kind: 'OBJECT', fields: Object.keys(fields) } };
  }
  return null;
}

// ---------------------------------------------------------------- the endpoint

function executeOne(store: Store, body: Record<string, unknown>): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'query is required' }] };
  }
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let doc: { operations: Operation[]; fragments: Map<string, FragmentDef> };
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: (err as Error).message }] };
  }
  if (doc.operations.length === 0) return { errors: [{ message: 'no operation in query' }] };
  let operation = doc.operations[0]!;
  if (operationName !== null) {
    const named = doc.operations.find((candidate) => candidate.name === operationName);
    if (named === undefined) return { errors: [{ message: `unknown operation ${operationName}` }] };
    operation = named;
  }
  const ctx: Ctx = { store, variables, fragments: doc.fragments, errors: [] };
  const root: GqlObj = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query', data: {} };
  const data = executeSelectionSet(root, operation.selections, ctx, []);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

/** POST /api/graphql: one operation document, or a JSON array of them (batched). */
export async function handleGraphql(store: Store, body: Buffer): Promise<HandlerResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }) + '\n', 'utf8') };
  }
  const results = Array.isArray(parsed)
    ? parsed.map((entry) => (typeof entry === 'object' && entry !== null ? executeOne(store, entry as Record<string, unknown>) : { errors: [{ message: 'operation must be an object' }] }))
    : [typeof parsed === 'object' && parsed !== null ? executeOne(store, parsed as Record<string, unknown>) : { errors: [{ message: 'operation must be an object' }] }];
  const out = Array.isArray(parsed) ? results : results[0]!;
  return { status: 200, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(out)}\n`, 'utf8') };
}
