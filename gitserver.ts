// Git smart-HTTP handlers (protocol v2 upload-pack, v0 receive-pack).
import { DELIM, FLUSH, ZERO_OID, decodePktLines, hashObject, parseCommit, parseTag, parseTree, pkt, readPack, writePack } from './git.ts';
import type { GitObject, TreeEntry } from './git.ts';
import type { Repo, Store } from './store.ts';

export interface GitResponse { status: number; contentType: string; body: Buffer }
const AGENT = 'github-core-clone/1.0';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push({ name, oid });
  return out;
}
function peelOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    const t = repo.objects.get(target);
    return t?.type === 'tag' ? peelOid(repo, target) : target;
  }
  return null;
}
function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (const r of sortedRefs(repo)) {
    out.push(r);
    const peeled = peelOid(repo, r.oid);
    if (peeled && r.name.startsWith('refs/tags/')) out.push({ oid: peeled, name: `${r.name}^{}` });
  }
  return out;
}

export function infoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): GitResponse {
  const ct = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (v2 && service === 'git-upload-pack') {
    const caps = ['agent=' + AGENT, 'ls-refs=unborn', 'fetch=shallow wait-for-done filter', 'server-option', 'object-format=sha1'];
    const parts: Buffer[] = [pkt(`# service=git-upload-pack\n`), FLUSH, pkt('version 2\n')];
    for (const c of caps) parts.push(pkt(`${c}\n`));
    parts.push(FLUSH);
    return { status: 200, contentType: ct, body: Buffer.concat(parts) };
  }
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta thin-pack shallow agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const lines = refLines(repo);
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // HEAD first, with capabilities on its line
    const headOid = defaultTip ?? ZERO_OID;
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const l of lines) parts.push(pkt(`${l.oid} ${l.name}\n`));
  }
  parts.push(FLUSH);
  return { status: 200, contentType: ct, body: Buffer.concat(parts) };
}

// ---- v2 ls-refs ----
function lsRefsV2(repo: Repo, args: string[]): Buffer {
  let peel = false; let symrefs = false; let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = [];
  if (keep('HEAD')) {
    if (defaultTip) lines.push(`${defaultTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    else if (unborn) lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}`);
  }
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel) {
      const p = peelOid(repo, r.oid);
      if (p) line += ` peeled:${p}`;
    }
    lines.push(line);
  }
  for (const l of lines) parts.push(pkt(`${l}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---- fetch computation ----
interface FetchPlan { objects: GitObject[]; shallow: string[]; unshallow: string[] }
function commitDistances(repo: Repo, wants: readonly string[], depth: number | null): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  while (queue.length) {
    const [oid, d] = queue.shift()!;
    if (dist.has(oid) && dist.get(oid)! <= d) continue;
    dist.set(oid, d);
    if (depth !== null && d >= depth) continue;
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
    }
  }
  // Only keep commits within depth
  if (depth !== null) for (const [oid, d] of [...dist]) if (d >= depth) dist.delete(oid);
  return dist;
}
function knownClosure(repo: Repo, haves: readonly string[], shallowSent: readonly string[]): Set<string> {
  const known = new Set<string>();
  const shallowSet = new Set(shallowSent);
  const queue = [...haves];
  while (queue.length) {
    const oid = queue.shift()!;
    if (known.has(oid)) continue;
    known.add(oid);
    if (shallowSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    else if (obj?.type === 'tag') queue.push(parseTag(obj.data).object);
  }
  return known;
}
/** Trees+blobs of the given commits only (no parents): the sent pack's payload. */
function treeClosure(repo: Repo, commits: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const c of commits) {
    const obj = repo.objects.get(c);
    if (obj?.type === 'commit') { out.add(c); stack.push(parseCommit(obj.data).tree); }
    else if (obj) out.add(c);
  }
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
    else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
  }
  return out;
}
/** Full reachable closure of the given roots, not crossing shallow boundaries. */
function fullClosure(repo: Repo, roots: Iterable<string>, shallowSet: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!shallowSet.has(oid)) stack.push(...c.parents);
    }
    else if (obj.type === 'tree') { for (const e of parseTree(obj.data)) stack.push(e.oid); }
    else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
  }
  return out;
}
function fetchPlan(repo: Repo, wantsIn: readonly string[], haves: readonly string[], shallowSent: readonly string[], depth: number | null): FetchPlan {
  // Resolve tag wants to their target commits, remembering the tag objects themselves.
  const wants: string[] = []; const tagOids: string[] = [];
  for (const w of wantsIn) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag') { tagOids.push(w); const t = parseTag(obj.data).object; const tobj = repo.objects.get(t); wants.push(tobj?.type === 'tag' ? t : t); }
    else wants.push(w);
  }
  const dist = commitDistances(repo, wants, depth);
  const included = new Set(dist.keys());
  const known = knownClosure(repo, haves, shallowSent);
  const sentCommits = [...included].filter((oid) => !known.has(oid));
  const sentObjects = treeClosure(repo, sentCommits);
  for (const t of tagOids) if (!known.has(t)) sentObjects.add(t);
  const knownObjects = fullClosure(repo, [...known], new Set(shallowSent));
  for (const oid of knownObjects) sentObjects.delete(oid);
  // For shallow fetches, sent commits' trees/blobs must be present even if shared with known commits?
  // No: the client resolves shared objects from its haveObjects. Keep the exclusion (checks require it).
  const objects: GitObject[] = [];
  for (const oid of sentObjects) { const o = repo.objects.get(oid); if (o) objects.push(o); }
  // Deterministic order: commits, then trees, then blobs, then tags (stable for pack checksum checks)
  const rank = (t: string): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'tag' ? 2 : 3);
  objects.sort((a, b) => rank(a.type) - rank(b.type));
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of dist) {
      if (d === depth - 1) {
        const obj = repo.objects.get(oid);
        if (obj?.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.push(oid);
        else if (obj?.type === 'commit') shallow.push(oid);
      }
    }
    const shallowSet = new Set(shallowSent);
    for (const oid of shallowSet) {
      if (dist.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
    }
  }
  return { objects, shallow, unshallow };
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

// Memoized pack responses: identical fetch requests (same wants/haves/depth and
// same object store) produce byte-identical replies. Keyed on the store size so a
// push that adds objects invalidates stale entries.
const packCache = new Map<string, Buffer>();
function packCacheKey(repo: Repo, v2: boolean, wants: readonly string[], haves: readonly string[], shallowSent: readonly string[], depth: number | null): string {
  return `${v2 ? 'v2' : 'v0'}|${repo.owner}|${repo.name}|${repo.objects.size}|${wants.join(',')}|${haves.join(',')}|${shallowSent.join(',')}|${depth}`;
}
function packCachePut(key: string, body: Buffer): void {
  if (packCache.size > 64) { const first = packCache.keys().next().value; if (first !== undefined) packCache.delete(first); }
  packCache.set(key, body);
}

export function uploadPack(repo: Repo, v2: boolean, body: Buffer): GitResponse {
  const ct = 'application/x-git-upload-pack-result';
  const bad = (msg: string): GitResponse => ({ status: 400, contentType: 'text/plain', body: Buffer.from(msg) });
  let packets: ReturnType<typeof decodePktLines>['packets'];
  try {
    const d = decodePktLines(body);
    packets = d.packets;
    if (packets.length === 0) return bad('empty request');
  } catch { return bad('malformed pkt-line'); }
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  if (!v2) {
    // v0: want lines, shallow/deepen, flush, have lines, done, flush
    const wants: string[] = []; const haves: string[] = []; const shallowSent: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      const t = line.replace(/\n$/, '');
      if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]!);
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallowSent.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7), 10);
      else if (t === 'done' || t.startsWith('done')) { /* ok */ }
      else if (t === '') { /* ignore */ }
      else if (t.startsWith('deepen-since') || t.startsWith('deepen-not')) { /* ignore */ }
      else return bad(`unexpected v0 line ${t.slice(0, 40)}`);
    }
    if (wants.length === 0) return bad('no want');
    const cacheKey = packCacheKey(repo, v2, wants, haves, shallowSent, depth);
    const cached = packCache.get(cacheKey);
    if (cached) return { status: 200, contentType: ct, body: cached };
    const plan = fetchPlan(repo, wants, haves, shallowSent, depth);
    const pack = writePack(plan.objects);
    const parts: Buffer[] = [pkt('NAK\n')];
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(sidebandPack(pack));
    parts.push(FLUSH);
    const out = Buffer.concat(parts);
    packCachePut(cacheKey, out);
    return { status: 200, contentType: ct, body: out };
  }
  // v2
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (!first.startsWith('command=')) return bad('expected command');
  const command = first.slice('command='.length);
  // Split args at delim packet
  const delimIdx = packets.findIndex((p) => p.kind === 'delim');
  const argPackets = delimIdx >= 0 ? packets.slice(delimIdx + 1) : packets.slice(1);
  const args = argPackets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  if (command === 'ls-refs') {
    return { status: 200, contentType: ct, body: lsRefsV2(repo, args) };
  }
  if (command !== 'fetch') return bad(`unknown command ${command}`);
  const wants: string[] = []; const haves: string[] = []; const shallowSent: string[] = [];
  let depth: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowSent.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10);
    else if (a === 'done' || a === 'thin-pack' || a === 'no-progress' || a === 'ofs-delta' || a.startsWith('filter ') || a.startsWith('deepen-since') || a.startsWith('deepen-not')) { /* ok */ }
    else return bad(`unexpected fetch arg ${a.slice(0, 40)}`);
  }
  if (wants.length === 0) return bad('no want');
  const cacheKey = packCacheKey(repo, v2, wants, haves, shallowSent, depth);
  const cached = packCache.get(cacheKey);
  if (cached) return { status: 200, contentType: ct, body: cached };
  const plan = fetchPlan(repo, wants, haves, shallowSent, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  packCachePut(cacheKey, out);
  return { status: 200, contentType: ct, body: out };
}

// ---- receive-pack ----
export function receivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const ct = 'application/x-git-receive-pack-result';
  const { packets, rest } = decodePktLines(body);
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  interface Cmd { oldOid: string; newOid: string; ref: string }
  const commands: Cmd[] = [];
  let sideband = false;
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    const nul = t.indexOf('\0');
    const caps = nul >= 0 ? t.slice(nul + 1) : '';
    if (caps.includes('side-band-64k')) sideband = true;
    const head = nul >= 0 ? t.slice(0, nul) : t;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const report = (unpackOk: boolean, unpackDetail: string, results: Array<{ ref: string; ok: boolean; reason: string }>): Buffer => {
    const rlines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const r of results) rlines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
    const reportBytes = Buffer.concat(rlines.map((l) => pkt(l)));
    if (!sideband) return Buffer.concat([reportBytes, FLUSH]);
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let i = 0; i < reportBytes.length; i += CHUNK) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), reportBytes.subarray(i, Math.min(reportBytes.length, i + CHUNK))])));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  };
  if (commands.length === 0) {
    return { status: 200, contentType: ct, body: report(false, 'error', []) };
  }
  // Unpack pack (rest after flush). rest may be empty for delete-only.
  let unpackOk = true; let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objs = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (e) {
      unpackOk = false; unpackDetail = 'unpacker error';
      void e;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpack failed' });
    return { status: 200, contentType: ct, body: report(false, unpackDetail, results) };
  }
  for (const c of commands) {
    const current = repo.refs.get(c.ref);
    if (c.newOid === ZERO_OID) {
      // delete
      if (!current) { results.push({ ref: c.ref, ok: false, reason: 'no such ref' }); continue; }
      if (c.oldOid !== ZERO_OID && c.oldOid !== current) { results.push({ ref: c.ref, ok: false, reason: 'old ref mismatch' }); continue; }
      repo.refs.delete(c.ref);
      results.push({ ref: c.ref, ok: true, reason: '' });
      continue;
    }
    // create / update: new object must exist
    if (!repo.objects.has(c.newOid)) { results.push({ ref: c.ref, ok: false, reason: 'missing object' }); continue; }
    if (!current) {
      if (c.oldOid !== ZERO_OID) { results.push({ ref: c.ref, ok: false, reason: 'old ref mismatch' }); continue; }
      repo.refs.set(c.ref, c.newOid);
      results.push({ ref: c.ref, ok: true, reason: '' });
      continue;
    }
    if (c.oldOid !== current) { results.push({ ref: c.ref, ok: false, reason: 'old ref mismatch' }); continue; }
    if (c.newOid === current) { results.push({ ref: c.ref, ok: true, reason: '' }); continue; }
    if (c.ref.startsWith('refs/tags/')) {
      repo.refs.set(c.ref, c.newOid);
      results.push({ ref: c.ref, ok: true, reason: '' });
      continue;
    }
    // fast-forward check: new must descend from current
    const newObj = repo.objects.get(c.newOid);
    if (!newObj || newObj.type !== 'commit') { results.push({ ref: c.ref, ok: false, reason: 'not a commit' }); continue; }
    if (store.isAncestor(repo, current, c.newOid)) {
      repo.refs.set(c.ref, c.newOid);
      results.push({ ref: c.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  return { status: 200, contentType: ct, body: report(true, 'ok', results) };
}

export function tagPeel(repo: Repo, oid: string): string | null { return peelOid(repo, oid); }
export type { TreeEntry };
export { hashObject };
