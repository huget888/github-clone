// store.ts — the forge's whole state: one in-memory store, no disk, no outside service.
//
// Everything the suite can create or read lives here: git objects (SHA-1 blobs, trees,
// commits, tags) and refs per repository, plus the REST resources (issues, pull requests,
// comments, labels) that share the same repositories. The git object model is the real
// one — a tree's bytes are exactly git's, so a clone byte-compares against the client's
// own builder — and the REST resources sit beside it, not on top of a git binary.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- git objects

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The SHA-1 id of an object: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Sort key for a tree entry: git compares a directory as if its name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** A tree's bytes from its entries, in git's order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a), 'utf8');
    const kb = Buffer.from(treeSortKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A tree's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's bytes. Author/committer lines stay whole ("Name <email> ts +0000"). */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** A commit's bytes. The message is used as given (callers end it with '\n'). */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${info.tree}\n`;
  for (const parent of info.parents) out += `parent ${parent}\n`;
  out += `author ${info.author}\ncommitter ${info.committer}\n\n${info.message}`;
  return Buffer.from(out, 'utf8');
}

/** The author/committer line for a name, email and epoch seconds (+0000 always). */
export function ident(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

// ---------------------------------------------------------------- the clock

/**
 * The forge's only clock: it never reads the wall clock. It starts at MAKEFUN_TRIAL_NOW
 * when the trial sets it, else at the scenario epoch 2025-01-01, and advances one second
 * per reading, so two runs of the same requests stamp the same times.
 */
export class Clock {
  private readonly base: number;
  private tick = 0;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = raw === '' ? Number.NaN : Date.parse(raw) / 1000;
    this.base = Number.isFinite(parsed) ? Math.floor(parsed) : 1735689600;
  }

  /** Next epoch second. */
  nowSec(): number {
    return this.base + this.tick++;
  }

  /** Next timestamp as an ISO string. */
  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString();
  }
}

// ---------------------------------------------------------------- users

export interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

// The scenario's fixed identities (kit program/env/src/wire.ts, SCENARIO_SEED
// 0x6a09e667f3bcc909): the same in every trial, practice and final. The bearer token
// names the viewer; the other three exist so a repo under their name is a 404, not a 403.
export const VIEWER: UserRec = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
export const TEAMMATE: UserRec = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' };
export const STRANGER: UserRec = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' };
export const ORG: UserRec = { id: 2000, login: 'faint-meadow-org', name: 'faint-meadow-org', email: '', type: 'Organization' };

export const KNOWN_USERS: readonly UserRec[] = [VIEWER, TEAMMATE, STRANGER, ORG];

export function findUser(login: string): UserRec | undefined {
  return KNOWN_USERS.find((user) => user.login === login);
}

// ---------------------------------------------------------------- opaque ids

/** An opaque global id (GraphQL `id`, REST `node_id`): base64url of "kind:key". */
export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** Decode an opaque id, or null when it is not one of ours. */
export function parseGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- resources

export interface Label {
  name: string;
  color: string;
  description?: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: UserRec;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: UserRec;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  user: UserRec;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

// ---------------------------------------------------------------- the store

/** One HTTP answer from a surface handler: status, content type, bytes. */
export interface HandlerResult {
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  body: Buffer;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  readonly labels: Label[] = [];
  nextIssue = 1;
  nextPull = 1;

  constructor(
    id: number,
    owner: string,
    name: string,
    opts: { description?: string; isPrivate?: boolean },
    now: string,
  ) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = opts.description ?? '';
    this.isPrivate = opts.isPrivate ?? false;
    this.createdAt = now;
    this.updatedAt = now;
    this.pushedAt = now;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The tip of refs/heads/<branch>, or null when the ref does not exist. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The default branch's tip, or null for an unborn repository. */
  headTip(): string | null {
    return this.branchTip(this.defaultBranch);
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** All refs, in git's order (HEAD first is the caller's job). */
  refNames(): string[] {
    return [...this.refs.keys()].sort();
  }
}

export class Store {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean }): Repo {
    const now = this.clock.nowIso();
    const repo = new Repo(this.nextRepoId++, owner, name, opts, now);
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** The token owner's repositories, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  nextIssueNumericId(): number {
    return this.nextIssueId++;
  }

  nextPullNumericId(): number {
    return this.nextPullId++;
  }

  nextCommentNumericId(): number {
    return this.nextCommentId++;
  }

  /** Find a repository by its opaque global id ("repo:owner/name"). */
  repoByGid(id: string): Repo | undefined {
    const parsed = parseGid(id);
    if (parsed === null || parsed.kind !== 'repo') return undefined;
    const slash = parsed.key.indexOf('/');
    if (slash < 0) return undefined;
    return this.getRepo(parsed.key.slice(0, slash), parsed.key.slice(slash + 1));
  }

  issueByGid(id: string): { repo: Repo; issue: Issue } | undefined {
    const parsed = parseGid(id);
    if (parsed === null || parsed.kind !== 'issue') return undefined;
    const hash = parsed.key.indexOf('#');
    if (hash < 0) return undefined;
    const repo = this.getRepo(...splitOwnerRepo(parsed.key.slice(0, hash)));
    const number = Number(parsed.key.slice(hash + 1));
    if (repo === undefined || !Number.isInteger(number)) return undefined;
    const issue = repo.issues.find((entry) => entry.number === number);
    return issue === undefined ? undefined : { repo, issue };
  }

  pullByGid(id: string): { repo: Repo; pull: Pull } | undefined {
    const parsed = parseGid(id);
    if (parsed === null || parsed.kind !== 'pr') return undefined;
    const hash = parsed.key.indexOf('#');
    if (hash < 0) return undefined;
    const repo = this.getRepo(...splitOwnerRepo(parsed.key.slice(0, hash)));
    const number = Number(parsed.key.slice(hash + 1));
    if (repo === undefined || !Number.isInteger(number)) return undefined;
    const pull = repo.pulls.find((entry) => entry.number === number);
    return pull === undefined ? undefined : { repo, pull };
  }
}

function splitOwnerRepo(fullName: string): [string, string] {
  const slash = fullName.indexOf('/');
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

// ---------------------------------------------------------------- tree walking

/** The tree entries of a commit's tree (empty when the oid is unknown). */
export function treeEntriesOf(repo: Repo, treeOid: string): TreeEntry[] {
  const obj = repo.getObject(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

/** The flat file map of a tree: path -> {mode, oid} (no directories). */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  for (const entry of treeEntriesOf(repo, treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [child, value] of flattenTree(repo, entry.oid, path)) out.set(child, value);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Build a nested tree from a flat path map, storing every tree object. Returns the root oid. */
export function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ mode: value.mode, name: parts[parts.length - 1]!, oid: value.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return repo.putObject('tree', buildTree(entries));
  };
  return build(root);
}

/** The blob oid at `path` in a tree, or null when absent (a directory is null too). */
export function blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
  const flat = flattenTree(repo, treeOid);
  const entry = flat.get(path);
  return entry === undefined ? null : entry.oid;
}

/** A tree with `path` set to `blobOid` (or removed when null), storing the new trees. */
export function setPathInTree(repo: Repo, treeOid: string, path: string, blobOid: string | null): string {
  const flat = flattenTree(repo, treeOid);
  if (blobOid === null) flat.delete(path);
  else flat.set(path, { mode: '100644', oid: blobOid });
  return buildTreeFromFlat(repo, flat);
}

// ---------------------------------------------------------------- ancestry

/** Ancestors of a commit, children first (breadth-first over parents). */
export function ancestorsOf(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) if (!seen.has(parent)) queue.push(parent);
  }
  return out;
}

/** The merge base of two commits: the first ancestor of `a` that is also an ancestor of `b`. */
export function mergeBaseOf(repo: Repo, a: string, b: string): string | null {
  const bAncestors = new Set(ancestorsOf(repo, b));
  for (const oid of ancestorsOf(repo, a)) if (bAncestors.has(oid)) return oid;
  return null;
}

/** The commits reachable from a tip, children first, each once. */
export function commitsReachable(repo: Repo, tip: string): string[] {
  return ancestorsOf(repo, tip);
}

// ---------------------------------------------------------------- diffs

/** Lines of a blob's text. */
function blobLines(repo: Repo, oid: string | null): string[] {
  if (oid === null) return [];
  const obj = repo.getObject(oid);
  if (obj === undefined || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two blobs, by longest common subsequence. */
export function lineDiff(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const oldLines = blobLines(repo, oldOid);
  const newLines = blobLines(repo, newOid);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 250_000) {
    // Large files: common prefix/suffix only, still exact for whole-file rewrites.
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    return { additions: newLines.length - prefix - suffix, deletions: oldLines.length - prefix - suffix };
  }
  const n = oldLines.length;
  const m = newLines.length;
  const dp = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    let prev = 0;
    for (let j = 1; j <= m; j += 1) {
      const temp = dp[j]!;
      dp[j] = oldLines[i - 1] === newLines[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = temp;
    }
  }
  const common = dp[m]!;
  return { additions: m - common, deletions: n - common };
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): ChangedFile[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: ChangedFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const { deletions } = lineDiff(repo, b.oid, null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b === undefined && h !== undefined) {
      const { additions } = lineDiff(repo, null, h.oid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const { additions, deletions } = lineDiff(repo, b.oid, h.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------- three-way merge

export interface MergeResult {
  /** The merged tree oid (null when the merge conflicts). */
  tree: string | null;
  conflict: boolean;
}

/**
 * A three-way merge of `headTip` into `baseTip` with merge base `base`:
 * a path both sides changed differently from the base conflicts; anything else
 * takes the side that changed it. The merged tree is stored.
 */
export function threeWayMerge(repo: Repo, base: string, headTip: string, baseTip: string): MergeResult {
  const baseCommit = repo.getObject(base);
  const headCommit = repo.getObject(headTip);
  const tipCommit = repo.getObject(baseTip);
  if (baseCommit === undefined || headCommit === undefined || tipCommit === undefined) return { tree: null, conflict: true };
  const baseTree = flattenTree(repo, parseCommit(baseCommit.data).tree);
  const headTree = flattenTree(repo, parseCommit(headCommit.data).tree);
  const tipTree = flattenTree(repo, parseCommit(tipCommit.data).tree);
  const merged = new Map<string, { mode: string; oid: string }>();
  let conflict = false;
  const paths = new Set([...baseTree.keys(), ...headTree.keys(), ...tipTree.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    const t = tipTree.get(path);
    const bOid = b?.oid ?? null;
    const hOid = h?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (hOid === tOid) {
      if (hOid !== null) merged.set(path, { mode: (h ?? t)!.mode, oid: hOid });
    } else if (bOid === hOid) {
      if (tOid !== null) merged.set(path, { mode: t!.mode, oid: tOid });
    } else if (bOid === tOid) {
      if (hOid !== null) merged.set(path, { mode: h!.mode, oid: hOid });
    } else {
      conflict = true;
    }
  }
  if (conflict) return { tree: null, conflict: true };
  return { tree: buildTreeFromFlat(repo, merged), conflict: false };
}

/**
 * A pull request's mergeability: a three-way conflict check against its base.
 */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  const base = mergeBaseOf(repo, headTip, baseTip);
  if (base === null) return headTip !== baseTip;
  return !threeWayMerge(repo, base, headTip, baseTip).conflict;
}

/**
 * Merge a pull request: squash (one commit), merge (a merge commit with two
 * parents) or rebase (the same tree, one commit). The merge commit lands on the
 * base branch; the pull request closes as merged. Returns the merge sha, or a
 * reason when it cannot merge.
 */
export function mergePull(
  store: Store,
  repo: Repo,
  pull: Pull,
  method: string,
): { ok: true; sha: string } | { ok: false; reason: string } {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === null || baseTip === null) return { ok: false, reason: 'head or base branch does not exist' };
  const base = mergeBaseOf(repo, headTip, baseTip);
  if (base === null) return { ok: false, reason: 'No merge base' };
  const merged = threeWayMerge(repo, base, headTip, baseTip);
  if (merged.conflict || merged.tree === null) return { ok: false, reason: 'Merge conflict' };
  const epoch = store.clock.nowSec();
  const author = ident(VIEWER.login, VIEWER.email, epoch);
  const message =
    method === 'SQUASH' ? `${pull.title} (#${pull.number})\n` : `Merge pull request #${pull.number} from ${pull.headRef}\n`;
  const parents = method === 'MERGE' ? [baseTip, headTip] : [baseTip];
  const commit = buildCommit({ tree: merged.tree, parents, author, committer: author, message });
  const mergeSha = repo.putObject('commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  repo.updatedAt = store.clock.nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = store.clock.nowIso();
  pull.merge_commit_sha = mergeSha;
  pull.closed_at = pull.merged_at;
  pull.updated_at = pull.merged_at;
  return { ok: true, sha: mergeSha };
}
