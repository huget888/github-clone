// git.ts — git smart HTTP, implemented from the wire protocol, no git binary.
//
// Serves upload-pack protocol v2 (and v0, for the advertisement check) and receive-pack
// v0, over the same in-memory objects the REST surface reads. Packs carry plain objects
// only on the way out — the suite's client writes packs that way, and reads plain objects
// fine — so no delta encoding is ever needed when sending; deltas on the way in resolve
// (OFS_DELTA and REF_DELTA) so a pack from any git client unpacks.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  flattenTree,
  ancestorsOf,
  type GitObject,
  type GitObjectType,
  type HandlerResult,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

const MAX_PKT = 65520;

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > MAX_PKT) throw new Error(`pkt-line of ${len} bytes exceeds ${MAX_PKT}`);
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

type PktItem = string | Buffer | 'flush' | 'delim';

function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Decode pkt-lines from a buffer. With `stopAtFlush`, stops after the first flush
 * packet (the receive-pack command list ends there; the bytes after it are the
 * pack). Without it, decodes the whole buffer (upload-pack commands). Throws on
 * a line that is not a pkt-line at all — the caller turns that into a 400, never
 * a crash.
 */
function decodePktLines(buf: Buffer, stopAtFlush = false): { packets: DecodedPacket[]; end: number } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`not a pkt-line: ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, end: offset };
}

/** The data lines of a pkt-line stream, as text, ignoring flush/delim markers. */
function pktLinesText(buf: Buffer): string[] {
  const { packets } = decodePktLines(buf);
  const out: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_TYPE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** A valid empty pack: PACK + version 2 + count 0 + trailer SHA-1 (32 bytes). */
export function emptyPack(): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(0, 8);
  return Buffer.concat([head, createHash('sha1').update(head).digest()]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** A pack entry's size varint: low 4 bits first, then 7-bit groups. */
function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/** An OFS_DELTA base offset: the negative distance to the base entry. */
function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile: plain objects, OFS_DELTA and REF_DELTA all resolve. `resolveBase`
 * supplies a base a thin pack leaves out (the receiver already has it).
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!TYPE_CODE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = TYPE_CODE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Write a packfile from plain objects (no deltas), with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const object of objects) {
    const code = CODE_TYPE[object.type];
    const size = object.data.length;
    const header: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    header.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- fetch planning

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

export interface FetchPlan {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  /** Haves the server holds (ACK lines). */
  acks: string[];
}

/** A commit's committer timestamp, or 0 when unparsable. */
function commitTimestamp(repo: Repo, oid: string): number {
  const obj = repo.getObject(oid);
  if (obj === undefined || obj.type !== 'commit') return 0;
  const match = parseCommit(obj.data).committer.match(/ (\d+) [+-]\d{4}$/);
  return match === null ? 0 : Number(match[1]);
}

/**
 * Walk commits from `starts`, honouring a depth limit, a since cutoff and an
 * exclusion set. Returns the included commits and, for each, whether a parent was
 * cut off (that commit is a new shallow boundary).
 */
function walkWantCommits(
  repo: Repo,
  starts: readonly string[],
  opts: { depth?: number; since?: number; exclude: Set<string> },
): Map<string, boolean> {
  const included = new Map<string, boolean>(); // oid -> hasCutParent
  const queue: Array<{ oid: string; distance: number }> = starts.map((oid) => ({ oid, distance: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (opts.exclude.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      // A wanted tag: the tag itself is included, and its target is walked.
      const target = tagTarget(obj.data);
      if (target !== null) queue.push({ oid: target, distance });
      included.set(oid, false);
      continue;
    }
    if (obj.type !== 'commit') {
      included.set(oid, false);
      continue;
    }
    if (opts.depth !== undefined && distance >= opts.depth) continue;
    if (opts.since !== undefined && commitTimestamp(repo, oid) <= opts.since) continue;
    const parents = parseCommit(obj.data).parents;
    let cut = false;
    for (const parent of parents) {
      if (opts.exclude.has(parent)) {
        cut = true;
        continue;
      }
      if (opts.depth !== undefined && distance + 1 >= opts.depth) {
        cut = true;
        continue;
      }
      if (opts.since !== undefined && commitTimestamp(repo, parent) <= opts.since) {
        cut = true;
        continue;
      }
      queue.push({ oid: parent, distance: distance + 1 });
    }
    // A boundary only when a parent was cut off; a root commit has no parent to cut.
    included.set(oid, parents.length > 0 && cut);
  }
  return included;
}

/** The object a tag points at, or null. */
function tagTarget(data: Buffer): string | null {
  const match = data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
  return match === null ? null : match[1]!;
}

/** The closure of `starts`, stopping at `stopAt` (the boundary itself is included). */
function walkHaveCommits(repo: Repo, starts: readonly string[], stopAt: ReadonlySet<string>): Set<string> {
  const included = new Set<string>();
  const queue = [...starts];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    included.add(oid);
    if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target !== null) queue.push(target);
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (stopAt.has(oid)) continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return included;
}

/** Every object under a commit's tree, plus the commit itself (trees and blobs). */
function collectCommitObjects(repo: Repo, commitOid: string, out: Map<string, GitObject>): void {
  const commit = repo.getObject(commitOid);
  if (commit === undefined) return;
  out.set(commitOid, commit);
  if (commit.type !== 'commit') return;
  const treeOid = parseCommit(commit.data).tree;
  collectTreeObjects(repo, treeOid, out);
}

function collectTreeObjects(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const tree = repo.getObject(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  out.set(treeOid, tree);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') collectTreeObjects(repo, entry.oid, out);
    else {
      const blob = repo.getObject(entry.oid);
      if (blob !== undefined) out.set(entry.oid, blob);
    }
  }
}

/** The fetch plan: what to send, the new shallow boundaries, the old ones undone. */
export function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const cutoff = req.depth !== undefined || req.deepenSince !== undefined || req.deepenNot.length > 0;
  const exclude = new Set<string>();
  for (const not of req.deepenNot) for (const oid of ancestorsOf(repo, not)) exclude.add(oid);
  const wantWalked = walkWantCommits(repo, req.wants, { depth: req.depth, since: req.deepenSince, exclude });
  const haveWalked = walkHaveCommits(repo, req.haves, new Set(req.shallow));

  // Objects the receiver already holds: every have commit and its tree closure.
  const haveObjects = new Map<string, GitObject>();
  for (const oid of haveWalked) {
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') collectCommitObjects(repo, oid, haveObjects);
    else if (obj.type === 'tag') {
      haveObjects.set(oid, obj);
      const target = tagTarget(obj.data);
      if (target !== null) {
        const targetObj = repo.getObject(target);
        if (targetObj?.type === 'commit') collectCommitObjects(repo, target, haveObjects);
        else if (targetObj !== undefined) haveObjects.set(target, targetObj);
      }
    } else haveObjects.set(oid, obj);
  }

  const sendObjects = new Map<string, GitObject>();
  const sendCommits = new Set<string>();
  for (const oid of wantWalked.keys()) {
    if (haveWalked.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      sendCommits.add(oid);
      collectCommitObjects(repo, oid, sendObjects);
    } else if (obj.type === 'tag') {
      sendObjects.set(oid, obj);
      const target = tagTarget(obj.data);
      if (target !== null && !haveWalked.has(target)) {
        const targetObj = repo.getObject(target);
        if (targetObj?.type === 'commit') {
          sendCommits.add(target);
          collectCommitObjects(repo, target, sendObjects);
        } else if (targetObj !== undefined) sendObjects.set(target, targetObj);
      }
    } else {
      sendObjects.set(oid, obj);
    }
  }
  for (const oid of haveObjects.keys()) sendObjects.delete(oid);

  const shallow: string[] = [];
  if (cutoff) {
    for (const [oid, cut] of wantWalked) if (cut && !haveWalked.has(oid)) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of req.shallow) {
    if (!wantWalked.has(boundary)) continue;
    const obj = repo.getObject(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((parent) => sendCommits.has(parent))) unshallow.push(boundary);
  }
  const acks: string[] = [];
  for (const have of req.haves) if (repo.getObject(have) !== undefined) acks.push(have);
  return { objects: [...sendObjects.values()], shallow, unshallow, acks };
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'forge/1.0';

function v2Capabilities(): string[] {
  // Bare `ls-refs` (no `=unborn`): the suite's client requests the `unborn`
  // argument whenever the capability value names it, and the unborn line it
  // then answers (`unborn refs/heads/main`) is treated by the suite's
  // clone-empty check and its git fixture as a real ref with a zero tip,
  // which breaks both. The server still honours an `unborn` argument if a
  // client ever sends one; it just does not advertise it.
  return ['version 2', 'ls-refs', 'fetch=shallow wait-for-done', 'object-format=sha1', `agent=${AGENT}`];
}

function v0UploadCapabilities(repo: Repo): string[] {
  return [
    'side-band-64k',
    'shallow',
    'thin-pack',
    'ofs-delta',
    'multi_ack',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
  ];
}

function v0ReceiveCapabilities(): string[] {
  return ['report-status', 'side-band-64k', 'delete-refs', `agent=${AGENT}`];
}

/** All refs as v0 advertisement lines (HEAD first), plus peeled tag lines. */
function v0RefLines(repo: Repo): string[] {
  const lines: string[] = [];
  const head = repo.headTip();
  if (head !== null) lines.push(`${head} HEAD`);
  for (const name of repo.refNames()) {
    const oid = repo.refs.get(name)!;
    lines.push(`${oid} ${name}`);
    const obj = repo.getObject(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target !== null) lines.push(`${target} ${name}^{}`);
    }
  }
  return lines;
}

function advertiseUploadPackV2(): Buffer {
  const items: PktItem[] = [`# service=git-upload-pack\n`, 'flush', ...v2Capabilities().map((line) => `${line}\n`), 'flush'];
  return encodePktLines(items);
}

function advertiseUploadPackV0(repo: Repo): Buffer {
  const lines = v0RefLines(repo);
  const items: PktItem[] = [`# service=git-upload-pack\n`, 'flush'];
  if (lines.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${v0UploadCapabilities(repo).join(' ')}\n`);
  } else {
    const [first, ...rest] = lines;
    items.push(`${first}\0${v0UploadCapabilities(repo).join(' ')}\n`);
    for (const line of rest) items.push(`${line}\n`);
  }
  items.push('flush');
  return encodePktLines(items);
}

function advertiseReceivePackV0(repo: Repo): Buffer {
  const lines = v0RefLines(repo);
  const items: PktItem[] = [`# service=git-receive-pack\n`, 'flush'];
  if (lines.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${v0ReceiveCapabilities().join(' ')}\n`);
  } else {
    const [first, ...rest] = lines;
    items.push(`${first}\0${v0ReceiveCapabilities().join(' ')}\n`);
    for (const line of rest) items.push(`${line}\n`);
  }
  items.push('flush');
  return encodePktLines(items);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, lines: readonly string[]): Buffer {
  const opts: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') opts.peel = true;
    else if (text === 'symrefs') opts.symrefs = true;
    else if (text === 'unborn') opts.unborn = true;
    else if (text.startsWith('ref-prefix ')) opts.prefixes.push(text.slice('ref-prefix '.length));
  }
  const out: string[] = [];
  const head = repo.headTip();
  const matches = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  if (head !== null) {
    if (matches('HEAD')) {
      let line = `${head} HEAD`;
      if (opts.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      out.push(line);
    }
  } else if (opts.unborn && matches(`refs/heads/${repo.defaultBranch}`)) {
    out.push(`unborn refs/heads/${repo.defaultBranch} symref-target:refs/heads/${repo.defaultBranch}`);
  }
  for (const name of repo.refNames()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const obj = repo.getObject(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = tagTarget(obj.data);
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    out.push(line);
  }
  return encodePktLines([...out.map((line) => `${line}\n`), 'flush']);
}

// ---------------------------------------------------------------- fetch (v2)

function sidebandPack(pack: Buffer): Buffer {
  // One band-1 packet per chunk (a pkt-line holds at most 65520 bytes total).
  const items: PktItem[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    items.push(Buffer.concat([Buffer.from([1]), slice]));
  }
  return encodePktLines(items);
}

function handleFetchV2(repo: Repo, lines: readonly string[]): Buffer {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.depth = Number(text.slice(7).trim());
    else if (text.startsWith('deepen-since ')) req.deepenSince = Number(text.slice(13).trim());
    else if (text.startsWith('deepen-not ')) req.deepenNot.push(text.slice(11).trim());
  }
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  // acknowledgments
  const ackLines: PktItem[] = ['acknowledgments\n'];
  if (plan.acks.length === 0) ackLines.push('NAK\n');
  else {
    for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  }
  ackLines.push('delim');
  parts.push(encodePktLines(ackLines));
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines2: PktItem[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines2.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines2.push(`unshallow ${oid}\n`);
    lines2.push('delim');
    parts.push(encodePktLines(lines2));
  }
  // wanted-refs
  const wantedRefs: string[] = [];
  const wantSet = new Set(req.wants);
  if (repo.headTip() !== null && wantSet.has(repo.headTip()!)) wantedRefs.push(`${repo.headTip()} HEAD`);
  for (const name of repo.refNames()) {
    const oid = repo.refs.get(name)!;
    if (wantSet.has(oid)) wantedRefs.push(`${oid} ${name}`);
  }
  if (wantedRefs.length > 0) {
    parts.push(encodePktLines(['wanted-refs\n', ...wantedRefs.map((line) => `${line}\n`), 'delim']));
  }
  // packfile
  const pack = plan.objects.length === 0 ? emptyPack() : writePack(plan.objects);
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch (v0)

function handleFetchV0(repo: Repo, lines: readonly string[]): Buffer {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.depth = Number(text.slice(7).trim());
    else if (text.startsWith('deepen-since ')) req.deepenSince = Number(text.slice(13).trim());
    else if (text.startsWith('deepen-not ')) req.deepenNot.push(text.slice(11).trim());
  }
  const plan = planFetch(repo, req);
  const items: PktItem[] = [];
  if (plan.acks.length === 0) items.push('NAK\n');
  else for (const ack of plan.acks) items.push(`ACK ${ack}\n`);
  for (const oid of plan.shallow) items.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) items.push(`unshallow ${oid}\n`);
  const pack = plan.objects.length === 0 ? emptyPack() : writePack(plan.objects);
  const packed = sidebandPack(pack);
  // sidebandPack already returns complete pkt-lines; append them raw.
  const head = encodePktLines(items);
  return Buffer.concat([head, packed, pktFlush()]);
}

// ---------------------------------------------------------------- receive-pack (v0)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Whether `newOid` descends from `oldOid` (or the update is a create/delete/no-op). */
function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (newOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  return ancestorsOf(repo, newOid).includes(oldOid);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, end } = decodePktLines(body, true);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') break; // the flush ends the command list
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) throw new Error('push command has a bad object id');
    if (!ref.startsWith('refs/')) throw new Error(`push command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  const packBytes = body.subarray(end);
  const hasUpdate = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (hasUpdate) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = readPack(packBytes, { resolveBase: (oid) => repo.getObject(oid) });
        for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      } catch (err) {
        unpackOk = false;
        unpackDetail = (err as Error).message;
      }
    }
  }
  const inner: PktItem[] = [];
  if (unpackOk) {
    inner.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (current !== command.oldOid) {
        inner.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (!isFastForward(repo, command.oldOid, command.newOid)) {
        inner.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      inner.push(`ok ${command.ref}\n`);
    }
  } else {
    inner.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) inner.push(`ng ${command.ref} unpack failed\n`);
  }
  const innerBytes = encodePktLines(inner);
  // The report-status stream rides inside band-1 sideband packets.
  const outer: PktItem[] = [Buffer.concat([Buffer.from([1]), innerBytes])];
  return Buffer.concat([encodePktLines(outer), pktFlush()]);
}

// ---------------------------------------------------------------- the HTTP surface

function jsonResult(status: number, body: unknown): HandlerResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

/**
 * Handle one git smart-HTTP request. `pathname` is the path after /{owner}/{repo}.git,
 * `query` the parsed query, `body` the raw request bytes.
 */
export async function handleGit(
  store: Store,
  expectedToken: string,
  method: string,
  owner: string,
  repoName: string,
  suffix: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): Promise<HandlerResult> {
  const auth = headers.authorization ?? '';
  if (expectedToken !== '' && auth !== `Bearer ${expectedToken}`) {
    return jsonResult(401, { message: 'Bad credentials' });
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResult(404, { message: 'Not Found' });
  const isV2 = (headers['git-protocol'] ?? '') === 'version=2';

  try {
    if (method === 'GET' && suffix === '/info/refs') {
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-advertisement',
          body: isV2 ? advertiseUploadPackV2() : advertiseUploadPackV0(repo),
        };
      }
      if (service === 'git-receive-pack') {
        return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseReceivePackV0(repo) };
      }
      return jsonResult(400, { message: 'Unknown service' });
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      if (isV2) {
        const lines = pktLinesText(body);
        const command = lines[0]?.replace(/\n$/, '') ?? '';
        if (command === 'command=ls-refs') {
          return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, lines.slice(1)) };
        }
        if (command === 'command=fetch') {
          return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(repo, lines.slice(1)) };
        }
        return jsonResult(400, { message: `Unknown command ${JSON.stringify(command)}` });
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(repo, pktLinesText(body)) };
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body: handleReceivePack(repo, body) };
    }
  } catch (err) {
    return jsonResult(400, { message: (err as Error).message });
  }
  return jsonResult(404, { message: 'Not Found' });
}
