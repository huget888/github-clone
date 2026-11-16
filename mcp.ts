// mcp.ts — Model Context Protocol over Streamable HTTP, revision 2026-07-28.
//
// POST /mcp speaks JSON-RPC 2.0: `server/discover` (the modern handshake —
// identity, capabilities and supported versions in one answer), `initialize`
// for the pre-discover era, `tools/list` and `tools/call`. The tools act on the
// same store as REST, so a repository or issue created here reads back over
// /api/v3 as the same object. No session: every request is self-contained.
// A request without the bearer token is 401; a body that is not JSON is HTTP
// 400 with JSON-RPC -32700.

import {
  VIEWER,
  gid,
  mergePull,
  type HandlerResult,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

// ---------------------------------------------------------------- the tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

// ---------------------------------------------------------------- tool results

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function getRepoOrError(store: Store, owner: unknown, repo: unknown): { repo: Repo } | { error: string } {
  if (typeof owner !== 'string' || typeof repo !== 'string') return { error: 'owner and repo are required' };
  const found = store.getRepo(owner, repo);
  if (found === undefined) return { error: `Repository ${owner}/${repo} not found` };
  return { repo: found };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') return errResult('name is required');
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
      if (owner !== VIEWER.login) return errResult(`cannot create a repository for ${owner}`);
      if (store.getRepo(owner, repoName) !== undefined) return errResult(`Repository ${repoName} already exists`);
      const repo = store.createRepo(owner, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return okResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const found = getRepoOrError(store, args.owner, args.repo);
      if ('error' in found) return errResult(found.error);
      return okResult(repoJson(store, found.repo));
    }
    case 'create_issue': {
      const found = getRepoOrError(store, args.owner, args.repo);
      if ('error' in found) return errResult(found.error);
      const title = args.title;
      if (typeof title !== 'string' || title === '') return errResult('title is required');
      const now = store.clock.nowIso();
      const issue: Issue = {
        id: store.nextIssueNumericId(),
        number: found.repo.nextIssue++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        user: VIEWER,
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      found.repo.issues.push(issue);
      return okResult(issueJson(store, found.repo, issue));
    }
    case 'list_issues': {
      const found = getRepoOrError(store, args.owner, args.repo);
      if ('error' in found) return errResult(found.error);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = found.repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return okResult({ issues: issues.map((issue) => issueJson(store, found.repo, issue)) });
    }
    case 'create_pull_request': {
      const found = getRepoOrError(store, args.owner, args.repo);
      if ('error' in found) return errResult(found.error);
      const repo = found.repo;
      const title = args.title;
      const head = args.head;
      const base = args.base;
      if (typeof title !== 'string' || title === '') return errResult('title is required');
      if (typeof head !== 'string' || typeof base !== 'string') return errResult('head and base are required');
      if (repo.branchTip(head) === null) return errResult(`head branch ${head} does not exist`);
      if (repo.branchTip(base) === null) return errResult(`base branch ${base} does not exist`);
      const now = store.clock.nowIso();
      const pull: Pull = {
        id: store.nextPullNumericId(),
        number: repo.nextPull++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
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
      const out = pullJson(store, repo, pull);
      return okResult({ ...out, head: head, base: base });
    }
    case 'merge_pull_request': {
      const found = getRepoOrError(store, args.owner, args.repo);
      if ('error' in found) return errResult(found.error);
      const number = args.pull_number;
      if (typeof number !== 'number' || !Number.isInteger(number)) return errResult('pull_number is required');
      const pull = found.repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return errResult(`Pull request #${number} not found`);
      const merged = mergePull(store, found.repo, pull, 'SQUASH');
      if (!merged.ok) return errResult(merged.reason);
      return okResult({ ...pullJson(store, found.repo, pull), sha: merged.sha });
    }
    default:
      return errResult(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function jsonResponse(status: number, body: unknown): HandlerResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

const ACCEPTED_REVISIONS = new Set(SUPPORTED_VERSIONS);

/** One JSON-RPC request (or notification); null when it is a notification. */
function handleRpc(store: Store, request: unknown): Record<string, unknown> | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = request as Record<string, unknown>;
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const method = req.method;
  if (typeof method !== 'string') return isNotification ? null : rpcError(id, -32600, 'Invalid Request');
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
      _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
    });
  }
  if (method === 'initialize') {
    const offered = params.protocolVersion;
    const negotiated =
      typeof offered === 'string' && ACCEPTED_REVISIONS.has(offered) ? offered : SUPPORTED_VERSIONS[0]!;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })) });
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name === '') return rpcError(id, -32602, 'a tool name is required');
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return rpcError(id, -32601, `Method not found: ${name}`);
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null);
    if (missing.length > 0) {
      return rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`);
    }
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** POST /mcp. */
export async function handleMcp(
  store: Store,
  expectedToken: string,
  method: string,
  headers: Record<string, string | undefined>,
  body: Buffer,
): Promise<HandlerResult> {
  if (method !== 'POST') {
    return jsonResponse(405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
  }
  const auth = headers.authorization ?? '';
  if (expectedToken !== '' && auth !== `Bearer ${expectedToken}`) {
    return { status: 401, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad credentials' }) + '\n', 'utf8') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonResponse(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(parsed)) {
    const out: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const answered = handleRpc(store, entry);
      if (answered !== null) out.push(answered);
    }
    return jsonResponse(200, out);
  }
  const answered = handleRpc(store, parsed);
  if (answered === null) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  }
  return jsonResponse(200, answered);
}
