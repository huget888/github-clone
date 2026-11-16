// rest.ts — GitHub REST v3, over the shared store.
//
// One handler for /api/v3/*. Every reply is JSON with a non-empty
// X-GitHub-Request-Id (app.ts adds it); errors carry a string `message`.
// A repository belongs to the login the token names (the viewer): the same name
// under another owner is a 404, never a 403.

import {
  VIEWER,
  findUser,
  gid,
  parseCommit,
  parseTree,
  buildCommit,
  ident,
  blobAtPath,
  setPathInTree,
  flattenTree,
  ancestorsOf,
  mergeBaseOf,
  diffTrees,
  threeWayMerge,
  pullMergeable,
  mergePull,
  type HandlerResult,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
  type UserRec,
} from './store.ts';

// ---------------------------------------------------------------- plumbing

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3 (decoded). */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Raw request body (may be empty). */
  body: Buffer;
  /** The request's origin (http://host:port) for pagination links. */
  origin: string;
  /** The request path after /api/v3, for pagination links. */
  path: string;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HandlerResult {
  return { status, contentType: 'application/json; charset=utf-8', headers, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

function notFound(message = 'Not Found'): HandlerResult {
  return json(404, { message });
}

function unprocessable(message: string): HandlerResult {
  return json(422, { message });
}

/** Parse a JSON body; null when empty, a 400 result when malformed. */
function parseBody(req: RestRequest): { ok: true; value: unknown } | { ok: false; result: HandlerResult } {
  const text = req.body.toString('utf8').trim();
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, result: json(400, { message: 'Problems parsing JSON' }) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
}

function intQuery(query: URLSearchParams, key: string, fallback: number): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A page of items plus the Link header GitHub sends (next/last when they exist). */
function paginate<T>(req: RestRequest, items: readonly T[]): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, intQuery(req.query, 'per_page', 30)));
  const page = Math.max(1, intQuery(req.query, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const base = `${req.origin}${req.path}`;
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
    links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  }
  return { page: [...pageItems], link: links.join(', ') };
}

function pageResponse<T>(req: RestRequest, items: readonly T[]): HandlerResult {
  const { page, link } = paginate(req, items);
  return json(200, page, link === '' ? {} : { link });
}

// ---------------------------------------------------------------- serializers

function userJson(user: UserRec): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: gid('user', user.login),
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: gid('repo', repo.fullName),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(findUser(repo.owner) ?? VIEWER),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description ?? null };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('issue', `${repo.fullName}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    assignees: [],
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.branchTip(pull.headRef) ?? '';
  const baseTip = repo.branchTip(pull.baseRef) ?? '';
  return {
    id: pull.id,
    node_id: gid('pr', `${repo.fullName}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: {
      ref: pull.headRef,
      sha: headTip,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(findUser(repo.owner) ?? VIEWER),
      repo: repoJson(store, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(findUser(repo.owner) ?? VIEWER),
      repo: repoJson(store, repo),
    },
    user: userJson(pull.user),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.getObject(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const authorLine = (line: string): { name: string; email: string; date: string } => {
    const match = line.match(/^(.*) <(.*)> (\d+) [+-]\d{4}$/);
    if (match === null) return { name: line, email: '', date: repo.createdAt };
    return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  const author = authorLine(info.author);
  const committer = authorLine(info.committer);
  return {
    sha,
    node_id: gid('commit', `${repo.fullName}#${sha}`),
    commit: {
      message: info.message,
      author,
      committer,
      tree: { sha: info.tree },
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
    author: { login: author.name, id: VIEWER.id },
    committer: { login: committer.name, id: VIEWER.id },
    url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------- contents

/** Make a commit on `branch` setting `path` to `content` (or deleting it). */
function commitFileChange(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const tip = repo.branchTip(branch);
  const parentTree = tip === null ? null : parseCommit(repo.getObject(tip)!.data).tree;
  let blobSha: string | null = null;
  let tree: string;
  if (content !== null) {
    blobSha = repo.putObject('blob', content);
    tree = parentTree === null ? setPathInTree(repo, emptyTreeOid(repo), path, blobSha) : setPathInTree(repo, parentTree, path, blobSha);
  } else {
    tree = parentTree === null ? emptyTreeOid(repo) : setPathInTree(repo, parentTree, path, null);
  }
  const epoch = store.clock.nowSec();
  const author = ident(VIEWER.login, VIEWER.email, epoch);
  const commit = buildCommit({ tree, parents: tip === null ? [] : [tip], author, committer: author, message: message.endsWith('\n') ? message : `${message}\n` });
  const commitSha = repo.putObject('commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = store.clock.nowIso();
  repo.pushedAt = repo.updatedAt;
  return { commitSha, blobSha };
}

function emptyTreeOid(repo: Repo): string {
  return repo.putObject('tree', Buffer.alloc(0));
}

/** Resolve a ref query (?ref=) to a commit oid, or null when it names nothing. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.headTip();
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.getObject(ref)?.type === 'commit' ? ref : null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) {
    const obj = repo.getObject(tag);
    if (obj?.type === 'tag') {
      const target = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      return target === null ? null : target[1]!;
    }
    return tag;
  }
  return null;
}

// ---------------------------------------------------------------- the routes

export async function handleRest(store: Store, req: RestRequest): Promise<HandlerResult> {
  const { method, segments: s } = req;

  // The API root: 200 with the token's scopes (no auth needed, as the starter had it).
  if ((method === 'GET' && s.length === 0) || (method === 'GET' && s.length === 1 && s[0] === '')) {
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'meta') {
    return json(200, { installed_version: '1.0.0' });
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'user') {
    return json(200, userJson(VIEWER));
  }
  if (method === 'GET' && s.length === 2 && s[0] === 'users') {
    const user = findUser(s[1]!);
    return user === undefined ? notFound() : json(200, userJson(user));
  }
  if (method === 'POST' && s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = isRecord(parsed.value) ? parsed.value : {};
    const name = stringField(body, 'name');
    if (name === undefined || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      return unprocessable('name is required and must be a valid repository name');
    }
    if (store.getRepo(VIEWER.login, name) !== undefined) {
      return unprocessable(`Repository ${name} already exists`);
    }
    const repo = store.createRepo(VIEWER.login, name, {
      description: stringField(body, 'description') ?? '',
      isPrivate: body.private === true,
    });
    return json(201, repoJson(store, repo));
  }
  if (method === 'GET' && s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    return pageResponse(req, store.listRepos(VIEWER.login).map((repo) => repoJson(store, repo)));
  }

  // Everything below names a repository.
  if (s.length >= 2 && s[0] === 'repos') {
    const owner = s[1]!;
    const name = s[2] ?? '';
    const repo = name === '' ? undefined : store.getRepo(owner, name);
    const rest = s.slice(3);

    if (method === 'GET' && s.length === 3) {
      return repo === undefined ? notFound() : json(200, repoJson(store, repo));
    }
    if (method === 'PATCH' && s.length === 3) {
      if (repo === undefined) return notFound();
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.result;
      const body = isRecord(parsed.value) ? parsed.value : {};
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      if (body.private === true || body.private === false) repo.isPrivate = body.private;
      repo.updatedAt = store.clock.nowIso();
      return json(200, repoJson(store, repo));
    }
    if (method === 'DELETE' && s.length === 3) {
      if (repo === undefined) return notFound();
      store.deleteRepo(owner, name);
      return { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
    }
    if (repo === undefined) return notFound();

    // Branches.
    if (method === 'GET' && rest.length === 1 && rest[0] === 'branches') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.branchTip(branch) }, protected: false }));
      return pageResponse(req, branches);
    }
    if (method === 'GET' && rest.length === 2 && rest[0] === 'branches') {
      const tip = repo.branchTip(rest[1]!);
      if (tip === null) return notFound();
      return json(200, { name: rest[1], commit: { sha: tip }, protected: false });
    }

    // Commits.
    if (method === 'GET' && rest.length === 1 && rest[0] === 'commits') {
      const sha = req.query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, sha);
      if (tip === null) return notFound();
      const commits = ancestorsOf(repo, tip)
        .map((oid) => commitJson(repo, oid))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      return pageResponse(req, commits);
    }
    if (method === 'GET' && rest.length === 2 && rest[0] === 'commits') {
      const found = commitJson(repo, rest[1]!);
      return found === null ? notFound() : json(200, found);
    }

    // Git Data: refs.
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.result;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
          return unprocessable('ref and sha are required');
        }
        if (repo.refs.has(ref)) return unprocessable('Reference already exists');
        if (repo.getObject(sha) === undefined) return unprocessable('Object does not exist');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET') {
        const wanted = `refs/${rest.slice(2).join('/')}`;
        if (rest.length === 2) {
          const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
          return pageResponse(req, all);
        }
        const exact = repo.refs.get(wanted);
        if (exact !== undefined) return json(200, { ref: wanted, object: { sha: exact } });
        const prefixed = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith(wanted))
          .map(([ref, sha]) => ({ ref, object: { sha } }));
        return prefixed.length === 0 ? notFound() : json(200, prefixed);
      }
      if (method === 'DELETE' && rest.length > 2) {
        const wanted = `refs/${rest.slice(2).join('/')}`;
        if (!repo.refs.has(wanted)) return notFound();
        repo.refs.delete(wanted);
        return { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
      }
    }

    // Contents.
    if (rest.length >= 1 && rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'PUT') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.result;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const message = stringField(body, 'message') ?? '';
        const contentB64 = stringField(body, 'content');
        if (contentB64 === undefined) return unprocessable('content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
          if (contentB64.replace(/\s/g, '') !== '' && content.length === 0 && contentB64.trim() !== '') throw new Error('bad base64');
        } catch {
          return unprocessable('content is not valid base64');
        }
        const branch = stringField(body, 'branch') ?? repo.defaultBranch;
        if (repo.branchTip(branch) === null && repo.headTip() !== null) {
          // A branch that does not exist yet starts at the default branch's tip.
          repo.refs.set(`refs/heads/${branch}`, repo.headTip()!);
        }
        const tip = repo.branchTip(branch);
        const currentTree = tip === null ? null : parseCommit(repo.getObject(tip)!.data).tree;
        const currentBlob = currentTree === null ? null : blobAtPath(repo, currentTree, path);
        const sha = stringField(body, 'sha');
        if (currentBlob !== null) {
          if (sha === undefined) return unprocessable('sha is required to update a file');
          if (sha.toLowerCase() !== currentBlob.toLowerCase()) return json(409, { message: 'sha does not match the current blob' });
        } else if (sha !== undefined) {
          return unprocessable('sha does not match any blob at this path');
        }
        const { commitSha, blobSha } = commitFileChange(store, repo, branch, path, content, message);
        return json(currentBlob === null ? 201 : 200, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobSha,
            size: content.length,
            type: 'file',
            encoding: 'base64',
            content: content.toString('base64'),
          },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'GET') {
        const tip = resolveRef(repo, req.query.get('ref'));
        if (tip === null) return notFound();
        const tree = parseCommit(repo.getObject(tip)!.data).tree;
        const flat = flattenTree(repo, tree);
        if (path === '') {
          const entries = dirListing(repo, tree, '');
          return json(200, entries);
        }
        const blob = flat.get(path);
        if (blob !== undefined) {
          const obj = repo.getObject(blob.oid)!;
          return json(200, {
            type: 'file',
            encoding: 'base64',
            content: obj.data.toString('base64'),
            sha: blob.oid,
            size: obj.data.length,
            name: path.split('/').pop() ?? path,
            path,
          });
        }
        const prefix = `${path}/`;
        const isDir = [...flat.keys()].some((key) => key.startsWith(prefix));
        if (!isDir) return notFound();
        return json(200, dirListing(repo, tree, path));
      }
      if (method === 'DELETE') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.result;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const branch = stringField(body, 'branch') ?? repo.defaultBranch;
        const tip = repo.branchTip(branch);
        if (tip === null) return notFound();
        const tree = parseCommit(repo.getObject(tip)!.data).tree;
        const currentBlob = blobAtPath(repo, tree, path);
        if (currentBlob === null) return notFound();
        const sha = stringField(body, 'sha');
        if (sha !== undefined && sha.toLowerCase() !== currentBlob.toLowerCase()) {
          return json(409, { message: 'sha does not match the current blob' });
        }
        const { commitSha } = commitFileChange(store, repo, branch, path, null, stringField(body, 'message') ?? '');
        return json(200, { commit: { sha: commitSha } });
      }
    }

    // Labels.
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') return pageResponse(req, repo.labels.map(labelJson));
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.result;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const name = stringField(body, 'name');
        if (name === undefined || name === '') return unprocessable('name is required');
        if (repo.labels.some((label) => label.name === name)) return unprocessable('Label already exists');
        const label: Label = { name, color: stringField(body, 'color') ?? 'ededed', description: stringField(body, 'description') };
        repo.labels.push(label);
        return json(201, labelJson(label));
      }
    }

    // Issues.
    if (rest.length >= 1 && rest[0] === 'issues') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.result;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = stringField(body, 'title');
        if (title === undefined || title === '') return unprocessable('title is required');
        const labels = resolveIssueLabels(repo, body.labels);
        if (labels === null) return unprocessable('a label does not exist');
        const now = store.clock.nowIso();
        const issue: Issue = {
          id: store.nextIssueNumericId(),
          number: repo.nextIssue++,
          title,
          body: stringField(body, 'body') ?? '',
          state: 'open',
          labels,
          user: VIEWER,
          created_at: now,
          updated_at: now,
          closed_at: null,
          comments: [],
        };
        repo.issues.push(issue);
        return json(201, issueJson(store, repo, issue));
      }
      if (method === 'GET' && rest.length === 1) {
        let issues = [...repo.issues];
        const state = req.query.get('state') ?? 'open';
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        const key = (issue: Issue): string => (sort === 'updated' ? issue.updated_at : issue.created_at);
        issues.sort((a, b) => {
          const cmp = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.number - b.number;
          return direction === 'asc' ? cmp : -cmp;
        });
        return pageResponse(req, issues.map((issue) => issueJson(store, repo, issue)));
      }
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.find((entry) => entry.number === number) : undefined;
      if (rest.length === 2 && rest[0] === 'issues') {
        if (issue === undefined) return notFound();
        if (method === 'GET') return json(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.result;
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = stringField(body, 'title');
          if (title !== undefined) issue.title = title;
          const bodyText = stringField(body, 'body');
          if (bodyText !== undefined) issue.body = bodyText;
          if (body.labels !== undefined) {
            const labels = resolveIssueLabels(repo, body.labels);
            if (labels === null) return unprocessable('a label does not exist');
            issue.labels = labels;
          }
          const state = stringField(body, 'state');
          if (state === 'closed' || state === 'open') {
            issue.state = state;
            issue.closed_at = state === 'closed' ? store.clock.nowIso() : null;
          }
          issue.updated_at = store.clock.nowIso();
          return json(200, issueJson(store, repo, issue));
        }
      }
      if (rest.length === 3 && rest[0] === 'issues' && rest[2] === 'comments') {
        if (issue === undefined) return notFound();
        if (method === 'GET') {
          return pageResponse(
            req,
            issue.comments.map((comment) => ({
              id: comment.id,
              node_id: gid('comment', `${repo.fullName}#${issue.number}:${comment.id}`),
              body: comment.body,
              user: userJson(comment.user),
              created_at: comment.created_at,
              updated_at: comment.updated_at,
            })),
          );
        }
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.result;
          const body = isRecord(parsed.value) ? parsed.value : {};
          const text = stringField(body, 'body');
          if (text === undefined || text === '') return unprocessable('body is required');
          const now = store.clock.nowIso();
          const comment = { id: store.nextCommentNumericId(), body: text, user: VIEWER, created_at: now, updated_at: now };
          issue.comments.push(comment);
          issue.updated_at = now;
          return json(201, {
            id: comment.id,
            node_id: gid('comment', `${repo.fullName}#${issue.number}:${comment.id}`),
            body: comment.body,
            user: userJson(comment.user),
            created_at: comment.created_at,
            updated_at: comment.updated_at,
          });
        }
      }
    }

    // Pull requests.
    if (rest.length >= 1 && rest[0] === 'pulls') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.result;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = stringField(body, 'title');
        const head = stringField(body, 'head');
        const base = stringField(body, 'base') ?? repo.defaultBranch;
        if (title === undefined || title === '' || head === undefined || head === '') return unprocessable('title, head and base are required');
        if (repo.branchTip(head) === null) return unprocessable(`head branch ${head} does not exist`);
        if (repo.branchTip(base) === null) return unprocessable(`base branch ${base} does not exist`);
        if (head === base) return unprocessable('head and base are the same branch');
        if (repo.pulls.some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base)) {
          return unprocessable('a pull request from this head already exists');
        }
        const now = store.clock.nowIso();
        const pull: Pull = {
          id: store.nextPullNumericId(),
          number: repo.nextPull++,
          title,
          body: stringField(body, 'body') ?? '',
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
        return json(201, pullJson(store, repo, pull));
      }
      if (method === 'GET' && rest.length === 1) {
        let pulls = [...repo.pulls];
        const state = req.query.get('state') ?? 'open';
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.number - a.number);
        return pageResponse(req, pulls.map((pull) => pullJson(store, repo, pull)));
      }
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.find((entry) => entry.number === number) : undefined;
      if (rest.length === 2 && rest[0] === 'pulls') {
        if (pull === undefined) return notFound();
        if (method === 'GET') return json(200, pullJson(store, repo, pull));
      }
      if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'files') {
        if (pull === undefined) return notFound();
        if (method === 'GET') {
          const headTip = repo.branchTip(pull.headRef);
          const baseTip = repo.branchTip(pull.baseRef);
          if (headTip === null || baseTip === null) return notFound();
          const base = mergeBaseOf(repo, headTip, baseTip) ?? baseTip;
          const baseTree = parseCommit(repo.getObject(base)!.data).tree;
          const headTree = parseCommit(repo.getObject(headTip)!.data).tree;
          const files = diffTrees(repo, baseTree, headTree).map((file) => ({
            filename: file.filename,
            status: file.status === 'removed' ? 'removed' : file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          }));
          return pageResponse(req, files);
        }
      }
      if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'merge') {
        if (pull === undefined) return notFound();
        if (method === 'PUT') {
          if (pull.state === 'closed') return json(405, { message: 'Pull request is already closed' });
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.result;
          const body = isRecord(parsed.value) ? parsed.value : {};
          const mergeMethod = (stringField(body, 'merge_method') ?? 'merge').toUpperCase();
          const merged = mergePull(store, repo, pull, mergeMethod);
          if (!merged.ok) return json(405, { message: merged.reason });
          return json(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
        }
      }
    }
  }

  return notFound();
}

/** An issue's labels from a request value (strings or {name} objects), or null. */
function resolveIssueLabels(repo: Repo, value: unknown): Label[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: Label[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? stringField(entry, 'name') : undefined;
    if (name === undefined) return null;
    const label = repo.labels.find((candidate) => candidate.name === name);
    if (label === undefined) return null;
    out.push(label);
  }
  return out;
}

/** The tree oid at `dir` under a tree ('' is the tree itself), or null. */
function treeAtPath(repo: Repo, treeOid: string, dir: string): string | null {
  if (dir === '') return treeOid;
  let current = treeOid;
  for (const segment of dir.split('/')) {
    const obj = repo.getObject(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

/** A directory listing for `dir` ('' is the root) under a tree. */
function dirListing(repo: Repo, treeOid: string, dir: string): Array<Record<string, unknown>> {
  const target = treeAtPath(repo, treeOid, dir);
  if (target === null) return [];
  const obj = repo.getObject(target);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data)
    .map((entry) => {
      const isDir = entry.mode === '40000';
      const blob = isDir ? undefined : repo.getObject(entry.oid);
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: dir === '' ? entry.name : `${dir}/${entry.name}`,
        sha: entry.oid,
        size: blob === undefined ? 0 : blob.data.length,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
