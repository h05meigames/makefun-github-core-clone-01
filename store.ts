// Shared in-process store: the seeded viewer identity (replicated RNG from the
// kit's wire.ts), repositories, git objects, issues, pull requests.
import { buildCommitBytes, buildTree, collectReachable, hashObject, parseCommit, parseTag, parseTree } from './git.ts';
import type { GitObject, TreeEntry } from './git.ts';

// ---- seeded scenario RNG (byte-identical copy of wire.ts) ----
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { h ^= BigInt(text.charCodeAt(i)); h = (h * 0x100000001b3n) & U64_MASK; }
  return h;
}
function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) { const m = seed & U64_MASK; this.#state = m === 0n ? SCENARIO_SEED : m; }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK; x = (x ^ (x << 25n)) & U64_MASK; x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296; const limit = range - (range % max);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % max; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)]!; }
}
const FIRST_NAMES = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST_NAMES = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];
export interface ScenarioUser { id: number; login: string; name: string; email: string }
function deriveUsers(): ScenarioUser[] {
  const seed = mix64(SCENARIO_SEED ^ fnv1a64('users'));
  const rng = new Rng(seed);
  const used = new Set<string>(); const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i++) {
    const first = rng.pick(FIRST_NAMES); const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base; let s = 2;
    while (used.has(login)) { login = `${base}-${s}`; s++; }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

// ---- data model ----
export interface Label { name: string; color: string; description: string }
export interface IssueComment { id: number; body: string; userLogin: string; createdAt: string; seq: number }
export interface Issue { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; labels: Label[]; comments: IssueComment[]; seq: number; createdAt: string; updatedAt: string }
export interface PRFile { filename: string; status: string; additions: number; deletions: number; changes: number }
export interface Pull { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headRef: string; baseRef: string; headSha: string; baseSha: string; files: PRFile[]; seq: number; createdAt: string }
export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdSeq: number;
  objects: Map<string, GitObject>; refs: Map<string, string>;
  labels: Map<string, Label>; issues: Issue[]; pulls: Pull[];
  nextNumber: number; fileMapCache: Map<string, Map<string, { oid: string; data: Buffer }>>;
}
const DEFAULT_LABELS: Array<[string, string]> = [['bug','d73a4a'],['enhancement','a2eeef'],['documentation','0075ca'],['question','d876e3'],['good first issue','7057ff'],['help wanted','008672']];

export function isoNow(): string { return new Date().toISOString(); }
function msgTrim(m: string): string { return m.replace(/\n+$/, ''); }

export class Store {
  viewer: ScenarioUser;
  users: ScenarioUser[];
  repos = new Map<string, Repo>();
  seq = 0;
  nextRepoId = 5000;
  nextGlobalId = 100000;
  constructor() {
    this.users = deriveUsers();
    this.viewer = this.users[0]!;
  }
  key(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  viewerRepos(): Repo[] { return [...this.repos.values()].filter((r) => r.owner === this.viewer.login).sort((a, b) => a.createdSeq - b.createdSeq); }
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.getRepo(this.viewer.login, name)) return null;
    const repo: Repo = {
      id: this.nextRepoId++, name, owner: this.viewer.login, description: description ?? '', private: !!isPrivate,
      defaultBranch: 'main', createdSeq: ++this.seq,
      objects: new Map(), refs: new Map(), labels: new Map(), issues: [], pulls: [],
      nextNumber: 1, fileMapCache: new Map(),
    };
    for (const [n, c] of DEFAULT_LABELS) repo.labels.set(n, { name: n, color: c, description: '' });
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }
  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }
  who(): string { return `${this.viewer.name} <${this.viewer.email}>`; }
  ts(): number { return Math.floor(Date.now() / 1000); }

  // ---- trees / file maps ----
  /** Build (and store) trees for a flat file map; returns root tree oid. */
  treeForFiles(repo: Repo, files: Map<string, { oid: string; data: Buffer }>): string {
    interface Node { files: Map<string, string>; dirs: Map<string, Node> }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, f] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i]!;
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segs[segs.length - 1]!, f.oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }
  fileMapOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; data: Buffer }> {
    const cached = repo.fileMapCache.get(commitOid);
    if (cached) return cached;
    const out = new Map<string, { oid: string; data: Buffer }>();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') { repo.fileMapCache.set(commitOid, out); return out; }
    const treeOid = parseCommit(commit.data).tree;
    const walk = (tree: string, prefix: string): void => {
      const t = repo.objects.get(tree);
      if (!t) return;
      for (const e of parseTree(t.data)) {
        const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, p);
        else {
          const blob = repo.objects.get(e.oid);
          if (blob) out.set(p, { oid: e.oid, data: blob.data });
        }
      }
    };
    walk(treeOid, '');
    repo.fileMapCache.set(commitOid, out);
    return out;
  }
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (!ref || ref === 'HEAD') { const t = repo.refs.get(`refs/heads/${repo.defaultBranch}`); return t ?? null; }
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
    if (repo.refs.has(`refs/tags/${ref}`)) {
      const oid = repo.refs.get(`refs/tags/${ref}`)!;
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') return parseTag(obj.data).object;
      return oid;
    }
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) {
      const obj = repo.objects.get(ref)!;
      if (obj.type === 'commit') return ref;
      if (obj.type === 'tag') return parseTag(obj.data).object;
    }
    return null;
  }
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = []; const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      queue.push(...parseCommit(obj.data).parents);
    }
    return out;
  }
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>(); const queue = [desc];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === anc) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return false;
  }
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancA = new Set(this.listCommits(repo, a));
    const queue = [b]; const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift()!;
      if (ancA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return null;
  }
  createCommit(repo: Repo, files: Map<string, { oid: string; data: Buffer }>, parents: readonly string[], message: string): string {
    const tree = this.treeForFiles(repo, files);
    const data = buildCommitBytes(tree, parents, message, this.who(), this.ts());
    return this.putObject(repo, 'commit', data);
  }
  /** Contents write/delete on a branch. Returns commit sha + blob sha (null on delete). */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    let files: Map<string, { oid: string; data: Buffer }>;
    let parents: string[] = [];
    if (tip) { files = new Map(this.fileMapOfCommit(repo, tip)); parents = [tip]; }
    else if (repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
      const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`)!;
      files = new Map(this.fileMapOfCommit(repo, baseTip)); parents = [baseTip];
    } else { files = new Map(); parents = []; }
    let blobSha: string | null = null;
    if (content === null) { files.delete(path); }
    else { blobSha = this.putObject(repo, 'blob', content); files.set(path, { oid: blobSha, data: content }); }
    const commitSha = this.createCommit(repo, files, parents, message);
    repo.refs.set(refName, commitSha);
    return { commitSha, blobSha };
  }
  commitView(repo: Repo, oid: string): { sha: string; commit: { message: string; author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string } }; parents: Array<{ sha: string }> } | null {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const c = parseCommit(obj.data);
    const parseWho = (s: string): { name: string; email: string; date: string } => {
      const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(s);
      if (!m) return { name: this.viewer.name, email: this.viewer.email, date: isoNow() };
      return { name: m[1]!, email: m[2]!, date: new Date(Number(m[3]) * 1000).toISOString() };
    };
    return { sha: oid, commit: { message: msgTrim(c.message), author: parseWho(c.author), committer: parseWho(c.committer) }, parents: c.parents.map((p) => ({ sha: p })) };
  }
  // ---- issues / pulls ----
  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const n of labelNames) {
      const l = repo.labels.get(n);
      if (!l) return { error: `Label does not exist: ${n}` };
      labels.push(l);
    }
    const now = isoNow();
    const issue: Issue = { id: this.nextGlobalId++, number: repo.nextNumber++, title, body: body ?? '', state: 'open', labels, comments: [], seq: ++this.seq, createdAt: now, updatedAt: now };
    repo.issues.push(issue);
    return issue;
  }
  diffLines(a: Buffer, b: Buffer): { additions: number; deletions: number } {
    const al = a.toString('utf8').split('\n'); const bl = b.toString('utf8').split('\n');
    const aCount = new Map<string, number>(); for (const l of al) aCount.set(l, (aCount.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of bl) { const c = aCount.get(l) ?? 0; if (c > 0) aCount.set(l, c - 1); else additions++; }
    const bCount = new Map<string, number>(); for (const l of bl) bCount.set(l, (bCount.get(l) ?? 0) + 1);
    let deletions = 0;
    for (const l of al) { const c = bCount.get(l) ?? 0; if (c > 0) bCount.set(l, c - 1); else deletions++; }
    return { additions, deletions };
  }
  computePRFiles(repo: Repo, baseOid: string, headOid: string): PRFile[] {
    const base = this.fileMapOfCommit(repo, baseOid);
    const head = this.fileMapOfCommit(repo, headOid);
    const files: PRFile[] = [];
    const all = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...all].sort()) {
      const b = base.get(path); const h = head.get(path);
      if (b && !h) { const d = this.diffLines(b.data, Buffer.alloc(0)); files.push({ filename: path, status: 'removed', additions: 0, deletions: d.deletions, changes: d.deletions }); }
      else if (!b && h) { const d = this.diffLines(Buffer.alloc(0), h.data); files.push({ filename: path, status: 'added', additions: Math.max(1, d.additions), deletions: 0, changes: Math.max(1, d.additions) }); }
      else if (b && h && b.oid !== h.oid) {
        const d = this.diffLines(b.data, h.data);
        const add = Math.max(d.additions, 1);
        files.push({ filename: path, status: 'modified', additions: add, deletions: d.deletions, changes: add + d.deletions });
      }
    }
    return files;
  }
  prMergeable(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!baseTip) return 'CONFLICTING';
    if (pr.state !== 'open') return 'CONFLICTING';
    // fast-forward or descendant?
    if (this.isAncestor(repo, baseTip, pr.headSha)) return 'MERGEABLE';
    const mb = this.mergeBase(repo, baseTip, pr.headSha);
    if (!mb) return 'CONFLICTING';
    const mbFiles = this.fileMapOfCommit(repo, mb);
    const baseFiles = this.fileMapOfCommit(repo, baseTip);
    const headFiles = this.fileMapOfCommit(repo, pr.headSha);
    const all = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const p of all) {
      const m = mbFiles.get(p)?.oid; const b = baseFiles.get(p)?.oid; const h = headFiles.get(p)?.oid;
      const baseChanged = b !== m; const headChanged = h !== m;
      if (baseChanged && headChanged && b !== h) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha) return { error: `head branch not found: ${headRef}` };
    if (!baseSha) return { error: `base branch not found: ${baseRef}` };
    const files = this.computePRFiles(repo, baseSha, headSha);
    const now = isoNow();
    const pr: Pull = { id: this.nextGlobalId++, number: repo.nextNumber++, title, body: body ?? '', state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, files, seq: ++this.seq, createdAt: now };
    repo.pulls.push(pr);
    return pr;
  }
  mergePull(repo: Repo, pr: Pull): { sha: string } | { conflict: true } | { already: string } {
    if (pr.merged && pr.mergeCommitSha) return { already: pr.mergeCommitSha };
    if (this.prMergeable(repo, pr) === 'CONFLICTING') return { conflict: true };
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`)!;
    const baseFiles = this.fileMapOfCommit(repo, baseTip);
    const headFiles = this.fileMapOfCommit(repo, pr.headSha);
    const merged = new Map(baseFiles);
    // apply head's changed files relative to merge-base (squash semantics: head wins on its changed paths)
    const mb = this.mergeBase(repo, baseTip, pr.headSha);
    const mbFiles = mb ? this.fileMapOfCommit(repo, mb) : new Map<string, { oid: string; data: Buffer }>();
    for (const path of pr.files.map((f) => f.filename)) {
      const h = headFiles.get(path);
      if (h) merged.set(path, h);
      else merged.delete(path);
    }
    // also any file that differs head vs base and not in files list (shouldn't happen) — ignore
    void mbFiles;
    const commitSha = this.createCommit(repo, merged, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commitSha);
    pr.state = 'closed'; pr.merged = true; pr.mergedAt = isoNow(); pr.mergeCommitSha = commitSha; pr.baseSha = commitSha;
    return { sha: commitSha };
  }
  reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable((oid) => repo.objects.get(oid), roots);
  }
}

// ---- global ids (opaque, stable) ----
export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}
export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}
