// Minimal GraphQL v4 executor for the documents gh / github-mcp-server send.
// Hand-written tokenizer + parser + typed resolvers; validates field names
// against a small schema so an invalid field is a 200 with an errors array.
import { gid, parseGid } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------- tokenizer ----------
type Tok = { kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread'; value: string };
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { toks.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { toks.push({ kind: 'punct', value: ch }); i++; continue; }
    if (ch === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { const n = src[j + 1]!; out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n; j += 2; } else { out += src[j]; j++; } }
      toks.push({ kind: 'string', value: out }); i = j + 1; continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; let isFloat = false;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === '.') { isFloat = true; j++; while (j < src.length && /[0-9]/.test(src[j]!)) j++; }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) }); i = j; continue;
    }
    i++;
  }
  return toks;
}

// ---------- AST ----------
interface ArgValue { kind: 'var' | 'string' | 'int' | 'float' | 'bool' | 'null' | 'enum' | 'list' | 'object'; value: unknown }
interface FieldNode { alias: string | null; name: string; args: Record<string, ArgValue>; selection: FieldNode[] | null; fragmentType: string | null }
interface Operation { op: 'query' | 'mutation'; name: string | null; varDefs: Record<string, { type: string; default?: ArgValue }>; selection: FieldNode[] }
class Parser {
  toks: Tok[]; pos = 0;
  constructor(src: string) { this.toks = tokenize(src); }
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok { return this.toks[this.pos++]!; }
  expectPunct(v: string): void { const t = this.next(); if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.value}`); }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.toks.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') { ops.push({ op: 'query', name: null, varDefs: {}, selection: this.parseSelection() }); continue; }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const nt = this.peek();
        if (nt?.kind === 'name') { name = this.next().value; }
        let varDefs: Operation['varDefs'] = {};
        if (this.peek()?.value === '(') varDefs = this.parseVarDefs();
        ops.push({ op: t.value as 'query' | 'mutation', name, varDefs, selection: this.parseSelection() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        // Named fragments are not used by the checks; skip the definition.
        this.next(); this.next();
        if (this.peek()?.value === 'on') { this.next(); this.next(); }
        this.parseSelection();
        continue;
      }
      this.next();
    }
    return ops;
  }
  parseVarDefs(): Operation['varDefs'] {
    const defs: Operation['varDefs'] = {};
    this.expectPunct('(');
    while (this.peek()?.value !== ')') {
      this.expectPunct('$');
      const name = this.next().value;
      this.expectPunct(':');
      let type = '';
      if (this.peek()?.value === '[') { this.next(); type += '['; type += this.next().value; if (this.peek()?.value === '!') { this.next(); type += '!'; } this.expectPunct(']'); }
      else type = this.next().value;
      if (this.peek()?.value === '!') { this.next(); type += '!'; }
      let def: ArgValue | undefined;
      if (this.peek()?.value === '=') { this.next(); def = this.parseValue(); }
      defs[name] = { type, default: def };
    }
    this.expectPunct(')');
    return defs;
  }
  parseSelection(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (this.peek()?.value !== '}') {
      const t = this.peek()!;
      if (t.kind === 'spread') {
        this.next();
        let fragType: string | null = null;
        if (this.peek()?.kind === 'name' && this.peek()!.value === 'on') { this.next(); fragType = this.next().value; }
        const sel = this.parseSelection();
        for (const f of sel) fields.push({ ...f, fragmentType: fragType ?? f.fragmentType });
        continue;
      }
      let alias: string | null = null;
      let name = this.next().value;
      if (this.peek()?.value === ':') { this.next(); alias = name; name = this.next().value; }
      const args: Record<string, ArgValue> = {};
      if (this.peek()?.value === '(') {
        this.expectPunct('(');
        while (this.peek()?.value !== ')') {
          const aname = this.next().value;
          this.expectPunct(':');
          args[aname] = this.parseValue();
        }
        this.expectPunct(')');
      }
      let selection: FieldNode[] | null = null;
      if (this.peek()?.value === '{') selection = this.parseSelection();
      fields.push({ alias, name, args, selection, fragmentType: null });
    }
    this.expectPunct('}');
    return fields;
  }
  parseValue(): ArgValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', value: this.next().value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const list: ArgValue[] = [];
      while (this.peek()?.value !== ']') list.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', value: list };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, ArgValue> = {};
      while (this.peek()?.value !== '}') { const k = this.next().value; this.expectPunct(':'); obj[k] = this.parseValue(); }
      this.expectPunct('}');
      return { kind: 'object', value: obj };
    }
    throw new Error(`unexpected token ${t.value}`);
  }
}
function resolveValue(v: ArgValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.value as string];
    case 'list': return (v.value as ArgValue[]).map((x) => resolveValue(x, vars));
    case 'object': { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v.value as Record<string, ArgValue>)) o[k] = resolveValue(x, vars); return o; }
    default: return v.value;
  }
}
function argsOf(f: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.args)) out[k] = resolveValue(v, vars);
  return out;
}

// ---------- schema (field validation) ----------
const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'createdAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'mergeCommit'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['name', 'color', 'description'],
  IssueComment: ['id', 'body'],
  CommentEdge: ['node'],
  AddCommentPayload: ['commentEdge'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  MergeCommit: ['oid'],
};
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'createdAt', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private'],
  SearchType: [],
};
const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ---------- executor ----------
interface Ctx { store: Store; vars: Record<string, unknown>; errors: Array<{ message: string }> }
function fieldOut(f: FieldNode): string { return f.alias ?? f.name; }
function cursorFor(index: number): string { return Buffer.from(`cursor:${index}`).toString('base64'); }
function cursorIndex(c: unknown): number {
  if (typeof c !== 'string') return -1;
  try { const t = Buffer.from(c, 'base64').toString('utf8'); const m = /^cursor:(\d+)$/.exec(t); return m ? parseInt(m[1]!, 10) : -1; } catch { return -1; }
}

function validateFields(fields: FieldNode[], typeName: string, ctx: Ctx, parentTypeForFragment: string | null = null): void {
  const allowed = SCHEMA[typeName] ?? [];
  for (const f of fields) {
    const effectiveType = f.fragmentType ?? typeName;
    const list = SCHEMA[effectiveType] ?? allowed;
    if (f.name.startsWith('__')) continue;
    if (!list.includes(f.name)) {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "${effectiveType}".` });
    }
  }
}

function resolveQuery(ctx: Ctx, fields: FieldNode[]): Record<string, unknown> {
  validateFields(fields, 'Query', ctx);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const args = argsOf(f, ctx.vars);
    if (f.name === 'viewer') out[fieldOut(f)] = resolveUser(ctx, f, ctx.store.viewer);
    else if (f.name === 'repository') {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      out[fieldOut(f)] = repo ? resolveRepo(ctx, f, repo) : null;
    } else if (f.name === 'node') {
      out[fieldOut(f)] = resolveNode(ctx, f, String(args.id ?? ''));
    } else if (f.name === '__type') {
      out[fieldOut(f)] = resolveType(ctx, f, String(args.name ?? ''));
    } else if (f.name === '__schema') {
      out[fieldOut(f)] = { types: [] };
    } else out[fieldOut(f)] = null;
  }
  return out;
}
function resolveUser(ctx: Ctx, f: FieldNode, user: { login: string; id: number; name: string; email: string }): Record<string, unknown> {
  if (f.selection) validateFields(f.selection, 'User', ctx);
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) {
    if (s.name === 'login') out[fieldOut(s)] = user.login;
    else if (s.name === 'id') out[fieldOut(s)] = gid('User', user.id);
    else if (s.name === 'name') out[fieldOut(s)] = user.name;
    else if (s.name === 'email') out[fieldOut(s)] = user.email;
    else out[fieldOut(s)] = null;
  }
  return out;
}
function resolveRepo(ctx: Ctx, f: FieldNode, repo: Repo): Record<string, unknown> {
  if (f.selection) validateFields(f.selection, 'Repository', ctx);
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) {
    const args = argsOf(s, ctx.vars);
    switch (s.name) {
      case 'id': out[fieldOut(s)] = gid('Repository', repo.id); break;
      case 'databaseId': out[fieldOut(s)] = repo.id; break;
      case 'name': out[fieldOut(s)] = repo.name; break;
      case 'nameWithOwner': out[fieldOut(s)] = `${repo.owner}/${repo.name}`; break;
      case 'owner': { const u = ctx.store.users.find((x) => x.login === repo.owner) ?? ctx.store.viewer; out[fieldOut(s)] = resolveUser(ctx, s, u); break; }
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[fieldOut(s)] = tip ? resolveRef(ctx, s, repo.defaultBranch) : null;
        break;
      }
      case 'viewerPermission': out[fieldOut(s)] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[fieldOut(s)] = true; break;
      case 'description': out[fieldOut(s)] = repo.description; break;
      case 'private': out[fieldOut(s)] = repo.private; break;
      case 'issue': {
        const n = Number(args.number);
        const issue = repo.issues.find((i) => i.number === n);
        out[fieldOut(s)] = issue ? resolveIssue(ctx, s, repo, issue) : null;
        break;
      }
      case 'issues': out[fieldOut(s)] = resolveIssueConnection(ctx, s, repo); break;
      case 'pullRequests': out[fieldOut(s)] = resolvePRConnection(ctx, s, repo); break;
      case 'pullRequest': {
        const n = Number(args.number);
        const pr = repo.pulls.find((p) => p.number === n);
        out[fieldOut(s)] = pr ? resolvePR(ctx, s, repo, pr) : null;
        break;
      }
      default: out[fieldOut(s)] = null;
    }
  }
  return out;
}
function resolveRef(ctx: Ctx, f: FieldNode, name: string): Record<string, unknown> {
  if (f.selection) validateFields(f.selection, 'Ref', ctx);
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) if (s.name === 'name') out[fieldOut(s)] = name;
  return out;
}
function issueStateGql(state: string): string { return state === 'open' ? 'OPEN' : 'CLOSED'; }
function resolveIssue(ctx: Ctx, f: FieldNode, repo: Repo, issue: Issue): Record<string, unknown> {
  if (f.selection) validateFields(f.selection, 'Issue', ctx);
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) {
    switch (s.name) {
      case 'id': out[fieldOut(s)] = gid('Issue', repo.id, issue.number); break;
      case 'number': out[fieldOut(s)] = issue.number; break;
      case 'title': out[fieldOut(s)] = issue.title; break;
      case 'state': out[fieldOut(s)] = issueStateGql(issue.state); break;
      case 'body': out[fieldOut(s)] = issue.body; break;
      case 'createdAt': out[fieldOut(s)] = issue.createdAt; break;
      case 'labels': out[fieldOut(s)] = { nodes: issue.labels.map((l) => ({ name: l.name, color: l.color })) }; break;
      default: out[fieldOut(s)] = null;
    }
  }
  return out;
}
function resolveIssueConnection(ctx: Ctx, f: FieldNode, repo: Repo): Record<string, unknown> {
  if (f.selection) validateFields(f.selection, 'IssueConnection', ctx);
  const args = argsOf(f, ctx.vars);
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) list = list.filter((i) => states.includes(issueStateGql(i.state)));
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  // Default (no orderBy): creation ascending; explicit CREATED_AT honours direction.
  if (orderBy) list.sort((a, b) => (a.seq - b.seq) * dir);
  else list.sort((a, b) => a.seq - b.seq);
  const afterIdx = cursorIndex(args.after);
  const start = afterIdx + 1;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) {
    if (s.name === 'nodes') out[fieldOut(s)] = page.map((issue) => resolveIssue(ctx, s, repo, issue));
    else if (s.name === 'edges') out[fieldOut(s)] = page.map((issue, i) => ({ node: resolveIssue(ctx, (s.selection ?? []).find((x) => x.name === 'node') ?? s, repo, issue), cursor: cursorFor(start + i) }));
    else if (s.name === 'pageInfo') out[fieldOut(s)] = resolvePageInfo(ctx, s, start, page.length, list.length);
    else if (s.name === 'totalCount') out[fieldOut(s)] = list.length;
    else out[fieldOut(s)] = null;
  }
  return out;
}
function resolvePageInfo(ctx: Ctx, f: FieldNode, start: number, pageLen: number, total: number): Record<string, unknown> {
  if (f.selection) validateFields(f.selection, 'PageInfo', ctx);
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) {
    if (s.name === 'hasNextPage') out[fieldOut(s)] = start + pageLen < total;
    else if (s.name === 'hasPreviousPage') out[fieldOut(s)] = start > 0;
    else if (s.name === 'endCursor') out[fieldOut(s)] = pageLen > 0 ? cursorFor(start + pageLen - 1) : null;
    else if (s.name === 'startCursor') out[fieldOut(s)] = pageLen > 0 ? cursorFor(start) : null;
    else out[fieldOut(s)] = null;
  }
  return out;
}
function prStateGql(pr: Pull): string { return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED'; }
function resolvePR(ctx: Ctx, f: FieldNode, repo: Repo, pr: Pull): Record<string, unknown> {
  if (f.selection) validateFields(f.selection, 'PullRequest', ctx);
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) {
    const args = argsOf(s, ctx.vars);
    switch (s.name) {
      case 'id': out[fieldOut(s)] = gid('PullRequest', repo.id, pr.number); break;
      case 'number': out[fieldOut(s)] = pr.number; break;
      case 'title': out[fieldOut(s)] = pr.title; break;
      case 'body': out[fieldOut(s)] = pr.body; break;
      case 'state': out[fieldOut(s)] = prStateGql(pr); break;
      case 'merged': out[fieldOut(s)] = pr.merged; break;
      case 'mergeable': out[fieldOut(s)] = ctx.store.prMergeable(repo, pr); break;
      case 'headRefName': out[fieldOut(s)] = pr.headRef; break;
      case 'baseRefName': out[fieldOut(s)] = pr.baseRef; break;
      case 'headRef': out[fieldOut(s)] = resolveRef(ctx, s, pr.headRef); break;
      case 'baseRef': out[fieldOut(s)] = resolveRef(ctx, s, pr.baseRef); break;
      case 'createdAt': out[fieldOut(s)] = pr.createdAt; break;
      case 'mergeCommit': out[fieldOut(s)] = pr.mergeCommitSha ? { oid: pr.mergeCommitSha } : null; break;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : pr.files.length;
        const nodesField = (s.selection ?? []).find((x) => x.name === 'nodes');
        const nodeSel = nodesField?.selection ?? [];
        const nodes = pr.files.slice(0, first).map((fl) => {
          const o: Record<string, unknown> = {};
          for (const sub of nodeSel) {
            if (sub.name === 'path' || sub.name === 'filename') o[fieldOut(sub)] = fl.filename;
            else if (sub.name === 'additions') o[fieldOut(sub)] = fl.additions;
            else if (sub.name === 'deletions') o[fieldOut(sub)] = fl.deletions;
            else if (sub.name === 'changes') o[fieldOut(sub)] = fl.changes;
            else o[fieldOut(sub)] = null;
          }
          return o;
        });
        const o: Record<string, unknown> = {};
        for (const sub of s.selection ?? []) {
          if (sub.name === 'nodes') o[fieldOut(sub)] = nodes;
          else if (sub.name === 'totalCount') o[fieldOut(sub)] = pr.files.length;
          else if (sub.name === 'pageInfo') o[fieldOut(sub)] = { hasNextPage: false, endCursor: null };
          else o[fieldOut(sub)] = null;
        }
        out[fieldOut(s)] = o;
        break;
      }
      default: out[fieldOut(s)] = null;
    }
  }
  return out;
}
function resolvePRConnection(ctx: Ctx, f: FieldNode, repo: Repo): Record<string, unknown> {
  if (f.selection) validateFields(f.selection, 'PullRequestConnection', ctx);
  const args = argsOf(f, ctx.vars);
  const list = repo.pulls.filter((p) => p.state === 'open');
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) {
    if (s.name === 'nodes') out[fieldOut(s)] = page.map((pr) => resolvePR(ctx, s, repo, pr));
    else if (s.name === 'edges') out[fieldOut(s)] = page.map((pr, i) => ({ node: resolvePR(ctx, (s.selection ?? []).find((x) => x.name === 'node') ?? s, repo, pr), cursor: cursorFor(i) }));
    else if (s.name === 'pageInfo') out[fieldOut(s)] = resolvePageInfo(ctx, s, 0, page.length, list.length);
    else if (s.name === 'totalCount') out[fieldOut(s)] = list.length;
    else out[fieldOut(s)] = null;
  }
  return out;
}
function resolveNode(ctx: Ctx, f: FieldNode, id: string): Record<string, unknown> | null {
  const parsed = parseGid(id);
  if (!parsed) return null;
  if (parsed.kind === 'Repository') {
    const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
    if (!repo) return null;
    // Build a Repository-shaped object honouring inline fragments / subfields.
    const out: Record<string, unknown> = { id: gid('Repository', repo.id) };
    for (const s of f.selection ?? []) {
      if (s.fragmentType && s.fragmentType !== 'Repository') continue;
      const fake: FieldNode = { alias: s.alias, name: s.name, args: s.args, selection: s.selection, fragmentType: null };
      const resolved = resolveRepo(ctx, { alias: null, name: 'repository', args: {}, selection: [fake], fragmentType: null }, repo);
      void resolved;
      // resolveRepo writes by alias; re-derive directly:
      if (s.name === 'name') out[fieldOut(s)] = repo.name;
      else if (s.name === 'nameWithOwner') out[fieldOut(s)] = `${repo.owner}/${repo.name}`;
      else if (s.name === 'id') out[fieldOut(s)] = gid('Repository', repo.id);
      else out[fieldOut(s)] = null;
    }
    return out;
  }
  if (parsed.kind === 'Issue') {
    const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
    if (!repo || !issue) return null;
    return resolveIssue(ctx, f, repo, issue);
  }
  if (parsed.kind === 'PullRequest') {
    const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
    const pr = repo?.pulls.find((p) => p.number === Number(parsed.parts[1]));
    if (!repo || !pr) return null;
    return resolvePR(ctx, f, repo, pr);
  }
  return null;
}
function resolveType(ctx: Ctx, f: FieldNode, name: string): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[name];
  const isEnum = name === 'SearchType';
  if (fields === undefined && !isEnum) return null;
  const out: Record<string, unknown> = {};
  for (const s of f.selection ?? []) {
    if (s.name === 'name') out[fieldOut(s)] = name;
    else if (s.name === 'kind') out[fieldOut(s)] = isEnum ? 'ENUM' : 'OBJECT';
    else if (s.name === 'description') out[fieldOut(s)] = null;
    else if (s.name === 'fields') {
      out[fieldOut(s)] = (fields ?? []).map((n) => ({ name: n, description: null }));
    } else if (s.name === 'enumValues') {
      out[fieldOut(s)] = isEnum ? SEARCH_ENUMS.map((n) => ({ name: n, description: null })) : [];
    } else out[fieldOut(s)] = null;
  }
  return out;
}
function resolveMutation(ctx: Ctx, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const args = argsOf(f, ctx.vars);
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (f.name === 'createIssue') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.parts[0])) : undefined;
      if (!repo) { ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' }); out[fieldOut(f)] = { issue: null }; continue; }
      const created = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) { ctx.errors.push({ message: created.error }); out[fieldOut(f)] = { issue: null }; continue; }
      out[fieldOut(f)] = { issue: pickFields(ctx, f, 'issue', (sub) => resolveIssue(ctx, sub, repo, created)) };
    } else if (f.name === 'closeIssue') {
      const parsed = parseGid(String(input.issueId ?? ''));
      let found: { repo: Repo; issue: Issue } | null = null;
      if (parsed?.kind === 'Issue') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
        if (repo && issue) found = { repo, issue };
      }
      if (!found) { ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' }); out[fieldOut(f)] = { issue: null }; continue; }
      found.issue.state = 'closed'; found.issue.updatedAt = new Date().toISOString();
      out[fieldOut(f)] = { issue: pickFields(ctx, f, 'issue', (sub) => resolveIssue(ctx, sub, found.repo, found.issue)) };
    } else if (f.name === 'createPullRequest') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.parts[0])) : undefined;
      if (!repo) { ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' }); out[fieldOut(f)] = { pullRequest: null }; continue; }
      const created = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in created) { ctx.errors.push({ message: created.error }); out[fieldOut(f)] = { pullRequest: null }; continue; }
      out[fieldOut(f)] = { pullRequest: pickFields(ctx, f, 'pullRequest', (sub) => resolvePR(ctx, sub, repo, created)) };
    } else if (f.name === 'mergePullRequest') {
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      let found: { repo: Repo; pr: Pull } | null = null;
      if (parsed?.kind === 'PullRequest') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        const pr = repo?.pulls.find((p) => p.number === Number(parsed.parts[1]));
        if (repo && pr) found = { repo, pr };
      }
      if (!found) { ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' }); out[fieldOut(f)] = { pullRequest: null }; continue; }
      const res = ctx.store.mergePull(found.repo, found.pr);
      if ('conflict' in res) { ctx.errors.push({ message: 'Pull request is not mergeable.' }); out[fieldOut(f)] = { pullRequest: pickFields(ctx, f, 'pullRequest', (sub) => resolvePR(ctx, sub, found.repo, found.pr)) }; continue; }
      out[fieldOut(f)] = { pullRequest: pickFields(ctx, f, 'pullRequest', (sub) => resolvePR(ctx, sub, found.repo, found.pr)) };
    } else if (f.name === 'addComment') {
      const parsed = parseGid(String(input.subjectId ?? ''));
      let found: { repo: Repo; issue: Issue } | null = null;
      if (parsed?.kind === 'Issue') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
        if (repo && issue) found = { repo, issue };
      }
      if (!found) { ctx.errors.push({ message: 'Could not resolve to a subject with the id provided.' }); out[fieldOut(f)] = { commentEdge: null }; continue; }
      const commentId = ctx.store.nextGlobalId++;
      const comment = { id: commentId, body: String(input.body ?? ''), userLogin: ctx.store.viewer.login, createdAt: new Date().toISOString(), seq: ++ctx.store.seq };
      found.issue.comments.push(comment);
      const node = { id: gid('IssueComment', found.repo.id, found.issue.number, commentId), body: comment.body };
      out[fieldOut(f)] = { commentEdge: { node } };
    } else {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` });
      out[fieldOut(f)] = null;
    }
  }
  return out;
}
/** Resolve the sub-selection of a payload field (e.g. createIssue.issue { number id }). */
function pickFields(ctx: Ctx, f: FieldNode, childName: string, resolveChild: (sub: FieldNode) => Record<string, unknown>): Record<string, unknown> | null {
  const child = (f.selection ?? []).find((s) => s.name === childName);
  if (!child || !child.selection) return null;
  return resolveChild(child);
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors?: Array<{ message: string }> } {
  let ops: Operation[];
  try { ops = new Parser(query).parseDocument(); } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  let op = ops[0];
  if (operationName) { const found = ops.find((o) => o.name === operationName); if (found) op = found; }
  if (!op) return { data: null, errors: [{ message: 'No operation found.' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(op.varDefs)) {
    if (!(name in vars) && def.default !== undefined) vars[name] = resolveValue(def.default, vars);
  }
  const ctx: Ctx = { store, vars, errors: [] };
  const data = op.op === 'mutation' ? resolveMutation(ctx, op.selection) : resolveQuery(ctx, op.selection);
  if (ctx.errors.length) return { data, errors: ctx.errors };
  return { data };
}
