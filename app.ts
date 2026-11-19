// The forge server: health probe, git smart HTTP, REST v3, GraphQL v4, MCP.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './gitserver.ts';
import { executeGraphQL } from './graphql.ts';
import { MCP_TOOLS, callMcpTool, issueJson, prJson, repoJson } from './mcp.ts';
import { Store, isoNow } from './store.ts';
import type { Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const store = new Store();
let reqCounter = 0;

function reqId(): string { reqCounter += 1; return `req-${reqCounter}-${randomUUID()}`; }
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': reqId(), ...extra };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'x-github-request-id': reqId(), ...extra });
  res.end(body);
}
function notFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found' }); }
function unauthorized(res: ServerResponse): void { sendJson(res, 401, { message: 'Bad credentials' }); }
function badRequest(res: ServerResponse, msg: string): void { sendJson(res, 400, { message: msg }); }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => { total += c.length; if (total > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: null };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
}
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function dec(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  return { page: items.slice((pageNum - 1) * perPage, pageNum * perPage), totalPages, pageNum, perPage };
}
function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, pageNum: number, totalPages: number, perPage: number): string {
  const host = req.headers.host ?? '127.0.0.1';
  const url = (p: number): string => `http://${host}${basePath}?page=${p}&per_page=${perPage}`;
  const parts: string[] = [];
  if (pageNum < totalPages) { parts.push(`<${url(pageNum + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`); }
  if (pageNum > 1) { parts.push(`<${url(1)}>; rel="first"`, `<${url(pageNum - 1)}>; rel="prev"`); }
  return parts.join(', ');
}
function userJson(): Record<string, unknown> {
  const v = store.viewer;
  return { login: v.login, id: v.id, name: v.name, email: v.email, type: 'User', avatar_url: '', html_url: '' };
}
function repoFull(repo: Repo): Record<string, unknown> {
  return {
    ...repoJson(store, repo),
    html_url: '', clone_url: '', git_url: '', ssh_url: '', homepage: '', language: null,
    forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    created_at: isoNow(), updated_at: isoNow(), topics: [], visibility: repo.private ? 'private' : 'public',
    archived: false, disabled: false, has_issues: true, has_projects: true, has_wiki: true, has_pages: false, license: null,
  };
}
// Serialized single-issue responses, keyed by issue object, invalidated by a
// signature of the mutable fields (the read workload re-reads one issue 2000x).
const issueTextCache = new WeakMap<object, { sig: string; text: string }>();
function cachedIssueText(repo: Repo, issue: { state: string; title: string; body: string; updatedAt: string; comments: unknown[]; labels: { name: string }[] }): string {
  const sig = `${issue.state}|${issue.title}|${issue.body}|${issue.updatedAt}|${issue.comments.length}|${issue.labels.map((l) => l.name).join(',')}`;
  const hit = issueTextCache.get(issue);
  if (hit && hit.sig === sig) return hit.text;
  const text = `${JSON.stringify(issueJson(repo, issue as never))}\n`;
  issueTextCache.set(issue, { sig, text });
  return text;
}

function commentJson(repo: Repo, c: { id: number; body: string; userLogin: string; createdAt: string }): Record<string, unknown> {
  return { id: c.id, body: c.body, user: { login: c.userLogin }, created_at: c.createdAt, updated_at: c.createdAt };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams, body: unknown): Promise<void> {
  const method = req.method ?? 'GET';
  // GET /api/v3/ root
  if (segs.length === 0) {
    if (method !== 'GET') { notFound(res); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  const [first] = segs;
  if (first === 'meta' && method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }); return; }
  if (first === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } }, rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } });
    return;
  }
  if (first === 'user' && segs.length === 1 && method === 'GET') { sendJson(res, 200, userJson()); return; }
  if (first === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const { page, totalPages, pageNum, perPage } = paginate(repos, query);
      const extra: Record<string, string> = {};
      const link = linkHeader(req, '/api/v3/user/repos', query, pageNum, totalPages, perPage);
      if (link) extra.link = link;
      sendJson(res, 200, page.map((r) => repoFull(r)), extra);
      return;
    }
    if (method === 'POST') {
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') { sendJson(res, 422, { message: 'name is required' }); return; }
      const repo = store.createRepo(body.name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (!repo) { sendJson(res, 422, { message: 'Repository already exists' }); return; }
      sendJson(res, 201, repoFull(repo));
      return;
    }
    notFound(res); return;
  }
  if (first === 'repos' && segs.length >= 3) {
    const owner = dec(segs[1]!); const repoName = dec(segs[2]!);
    const repo = owner === store.viewer.login ? store.getRepo(owner, repoName) : undefined;
    if (!repo) { notFound(res); return; }
    const rest = segs.slice(3);
    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoFull(repo)); return; }
      if (method === 'PATCH') {
        if (isRecord(body)) {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.private = body.private;
        }
        sendJson(res, 200, repoFull(repo)); return;
      }
      if (method === 'DELETE') { store.deleteRepo(owner, repoName); sendJson(res, 204, null); return; }
      notFound(res); return;
    }
    const [sub] = rest;
    if (sub === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length));
        names.sort();
        const ordered = [repo.defaultBranch, ...names.filter((n) => n !== repo.defaultBranch)];
        sendJson(res, 200, ordered.map((n) => ({ name: n, commit: { sha: repo.refs.get(`refs/heads/${n}`) ?? '' }, protected: false })));
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = dec(rest[1]!);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { notFound(res); return; }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return;
      }
      notFound(res); return;
    }
    if (sub === 'commits' && method === 'GET') {
      const tip = store.resolveRef(repo, query.get('sha') ?? undefined);
      if (!tip) { sendJson(res, 200, []); return; }
      const commits = store.listCommits(repo, tip).map((oid) => store.commitView(repo, oid)).filter((c): c is NonNullable<typeof c> => c !== null);
      const { page } = paginate(commits, query);
      sendJson(res, 200, page);
      return;
    }
    if (sub === 'contents') {
      const path = rest.slice(1).map(dec).join('/');
      if (method === 'GET') {
        const tip = store.resolveRef(repo, query.get('ref') ?? undefined);
        if (!tip) { notFound(res); return; }
        const files = store.fileMapOfCommit(repo, tip);
        const hit = files.get(path);
        if (hit) {
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: hit.data.length, name: path.split('/').pop() ?? path, path, content: hit.data.toString('base64'), sha: hit.oid });
          return;
        }
        // directory?
        const prefix = path === '' ? '' : `${path}/`;
        const children = new Map<string, { isDir: boolean; path: string; oid: string; size: number }>();
        for (const [p, f] of files) {
          if (prefix !== '' && !p.startsWith(prefix)) continue;
          const restPath = prefix === '' ? p : p.slice(prefix.length);
          const firstSeg = restPath.split('/')[0]!;
          if (restPath.includes('/')) {
            if (!children.has(firstSeg)) children.set(firstSeg, { isDir: true, path: prefix + firstSeg, oid: '', size: 0 });
          } else {
            children.set(firstSeg, { isDir: false, path: p, oid: f.oid, size: f.data.length });
          }
        }
        if (children.size === 0) { notFound(res); return; }
        const entries = [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, c]) => ({
          type: c.isDir ? 'dir' : 'file', name, path: c.path,
          sha: c.oid, size: c.size,
        }));
        // dir sha must be a valid 40-hex: use a deterministic hash of the path
        const { createHash } = await import('node:crypto');
        for (const e of entries) if (e.type === 'dir') e.sha = createHash('sha1').update(`tree ${e.path}`).digest('hex');
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'PUT') {
        if (!isRecord(body) || typeof body.message !== 'string' || typeof body.content !== 'string') { badRequest(res, 'message and content are required'); return; }
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const existing = tip ? store.fileMapOfCommit(repo, tip).get(path) : undefined;
        if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) { sendJson(res, 409, { message: 'sha does not match the current blob' }); return; }
        const content = Buffer.from(body.content.replace(/[\r\n ]/g, ''), 'base64');
        const { commitSha, blobSha } = store.commitFile(repo, branch, path, content, body.message);
        sendJson(res, existing ? 200 : 201, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
          commit: { sha: commitSha, message: body.message },
        });
        return;
      }
      if (method === 'DELETE') {
        const tip = repo.refs.get(`refs/heads/${typeof (isRecord(body) ? body.branch : undefined) === 'string' ? (body as Record<string, unknown>).branch as string : repo.defaultBranch}`);
        const existing = tip ? store.fileMapOfCommit(repo, tip).get(path) : undefined;
        if (!existing) { notFound(res); return; }
        if (isRecord(body) && typeof body.sha === 'string' && body.sha !== existing.oid) { sendJson(res, 409, { message: 'sha does not match the current blob' }); return; }
        const branch = isRecord(body) && typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const { commitSha } = store.commitFile(repo, branch, path, null, isRecord(body) && typeof body.message === 'string' ? body.message : `Delete ${path}`);
        sendJson(res, 200, { commit: { sha: commitSha } });
        return;
      }
      notFound(res); return;
    }
    if (sub === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') { badRequest(res, 'ref and sha are required'); return; }
        const ref = body.ref;
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) { sendJson(res, 422, { message: 'invalid ref' }); return; }
        if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
        if (!repo.objects.has(body.sha)) { sendJson(res, 422, { message: 'object does not exist' }); return; }
        repo.refs.set(ref, body.sha);
        sendJson(res, 201, { ref, object: { sha: body.sha, type: repo.objects.get(body.sha)?.type ?? 'commit' } });
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        sendJson(res, 200, [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } })));
        return;
      }
      if (method === 'GET' && rest.length === 4 && (rest[2] === 'heads' || rest[2] === 'tags')) {
        const ref = `refs/${rest[2]}/${dec(rest[3]!)}`;
        const sha = repo.refs.get(ref);
        if (!sha) { notFound(res); return; }
        sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
      notFound(res); return;
    }
    if (sub === 'labels') {
      if (method === 'GET') { sendJson(res, 200, [...repo.labels.values()]); return; }
      if (method === 'POST') {
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') { sendJson(res, 422, { message: 'name is required' }); return; }
        const existing = repo.labels.get(body.name);
        if (existing) { sendJson(res, 201, { id: store.nextGlobalId, name: existing.name, color: existing.color, description: existing.description }); return; }
        const label = { name: body.name, color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(label.name, label);
        sendJson(res, 201, { id: store.nextGlobalId++, name: label.name, color: label.color, description: label.description });
        return;
      }
      notFound(res); return;
    }
    if (sub === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const dir = query.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page } = paginate(list, query);
          sendJson(res, 200, page.map((i) => issueJson(repo, i)));
          return;
        }
        if (method === 'POST') {
          if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') { sendJson(res, 422, { message: 'title is required' }); return; }
          const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
          const created = store.createIssue(repo, body.title, typeof body.body === 'string' ? body.body : '', labels);
          if ('error' in created) { sendJson(res, 422, { message: created.error }); return; }
          sendJson(res, 201, issueJson(repo, created));
          return;
        }
        notFound(res); return;
      }
      const num = Number(rest[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) { notFound(res); return; }
      if (rest.length === 2) {
        if (method === 'GET') { sendRaw(res, 200, JSON_TYPE, Buffer.from(cachedIssueText(repo, issue))); return; }
        if (method === 'PATCH') {
          if (isRecord(body)) {
            if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            issue.updatedAt = isoNow();
          }
          sendJson(res, 200, issueJson(repo, issue)); return;
        }
        notFound(res); return;
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') { sendJson(res, 200, issue.comments.map((c) => commentJson(repo, c))); return; }
        if (method === 'POST') {
          if (!isRecord(body) || typeof body.body !== 'string') { badRequest(res, 'body is required'); return; }
          const c = { id: store.nextGlobalId++, body: body.body, userLogin: store.viewer.login, createdAt: isoNow(), seq: ++store.seq };
          issue.comments.push(c);
          sendJson(res, 201, commentJson(repo, c));
          return;
        }
        notFound(res); return;
      }
      notFound(res); return;
    }
    if (sub === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const { page } = paginate(list, query);
          sendJson(res, 200, page.map((p) => prJson(repo, p)));
          return;
        }
        if (method === 'POST') {
          if (!isRecord(body) || typeof body.title !== 'string') { sendJson(res, 422, { message: 'title is required' }); return; }
          const head = String(body.head ?? '').split(':').pop() ?? '';
          const base = String(body.base ?? repo.defaultBranch).split(':').pop() ?? repo.defaultBranch;
          const created = store.createPull(repo, body.title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in created) { sendJson(res, 422, { message: created.error }); return; }
          sendJson(res, 201, prJson(repo, created));
          return;
        }
        notFound(res); return;
      }
      const num = Number(rest[1]);
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) { notFound(res); return; }
      if (rest.length === 2 && method === 'GET') { sendJson(res, 200, prJson(repo, pr)); return; }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') { sendJson(res, 200, pr.files); return; }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pr.merged && pr.mergeCommitSha) { sendJson(res, 200, { sha: pr.mergeCommitSha, merged: true, message: 'Pull request successfully merged.' }); return; }
        const res2 = store.mergePull(repo, pr);
        if ('conflict' in res2) { sendJson(res, 405, { message: 'Pull request is not mergeable: merge conflict.' }); return; }
        sendJson(res, 200, { sha: res2.sha, merged: true, message: 'Pull request successfully merged.' });
        return;
      }
      notFound(res); return;
    }
    notFound(res); return;
  }
  notFound(res);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 200, { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = body.id ?? null;
  const isNotification = body.id === undefined;
  const params = isRecord(body.params) ? body.params : {};
  const reply = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const replyError = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  switch (body.method) {
    case 'server/discover':
      reply({
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' } },
      });
      return;
    case 'initialize': {
      const pv = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      const accepted = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      reply({ protocolVersion: accepted.includes(pv) ? pv : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } });
      return;
    }
    case 'notifications/initialized':
      if (isNotification) { res.writeHead(202, { 'x-github-request-id': reqId() }); res.end(); return; }
      reply({}); return;
    case 'ping': reply({}); return;
    case 'tools/list':
      reply({ tools: MCP_TOOLS });
      return;
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) { replyError(-32602, `Unknown tool: ${name}`); return; }
      reply(callMcpTool(store, name, args));
      return;
    }
    default:
      replyError(-32601, `Method not found: ${body.method}`);
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch) {
        if (!authed(req)) { unauthorized(res); return; }
        const owner = dec(gitMatch[1]!); const repoName = dec(gitMatch[2]!); const tail = gitMatch[3]!;
        const repo = owner === store.viewer.login ? store.getRepo(owner, repoName) : undefined;
        if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const raw = await readBody(req);
        if (method === 'GET' && tail === 'info/refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendJson(res, 400, { message: 'service is required' }); return; }
          const v2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
          const out = infoRefs(repo, service, v2);
          sendRaw(res, out.status, out.contentType, out.body);
          return;
        }
        if (method === 'POST' && tail === 'git-upload-pack') {
          const v2 = req.headers['git-protocol'] === 'version=2';
          const out = uploadPack(repo, v2, raw);
          sendRaw(res, out.status, out.contentType, out.body);
          return;
        }
        if (method === 'POST' && tail === 'git-receive-pack') {
          const out = receivePack(store, repo, raw);
          sendRaw(res, out.status, out.contentType, out.body);
          return;
        }
        notFound(res); return;
      }
      if (path === '/mcp') {
        if (!authed(req)) { sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }); return; }
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        const raw = await readBody(req);
        await handleMcp(req, res, raw);
        return;
      }
      if (path === '/api/graphql') {
        if (!authed(req)) { unauthorized(res); return; }
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { badRequest(res, 'malformed JSON body'); return; }
        if (Array.isArray(parsed.value)) {
          const out = parsed.value.map((op) => {
            if (!isRecord(op) || typeof op.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
            return executeGraphQL(store, op.query, isRecord(op.variables) ? op.variables : {}, typeof op.operationName === 'string' ? op.operationName : undefined);
          });
          sendJson(res, 200, out);
          return;
        }
        if (!isRecord(parsed.value) || typeof parsed.value.query !== 'string') { badRequest(res, 'query is required'); return; }
        const out = executeGraphQL(store, parsed.value.query, isRecord(parsed.value.variables) ? parsed.value.variables : {}, typeof parsed.value.operationName === 'string' ? parsed.value.operationName : undefined);
        sendJson(res, 200, out);
        return;
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authed(req)) { unauthorized(res); return; }
        const raw = await readBody(req);
        let body: unknown = null;
        if (raw.length > 0 && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { badRequest(res, 'malformed JSON body'); return; }
          body = parsed.value;
        }
        const segs = path.replace(/^\/api\/v3\/?/, '').split('/').filter((s) => s !== '');
        await handleRest(req, res, segs, url.searchParams, body);
        return;
      }
      if (!authed(req) && path !== '/healthz') { unauthorized(res); return; }
      notFound(res);
    } catch (e) {
      try { sendJson(res, 500, { message: e instanceof Error ? e.message : String(e) }); } catch { /* already sent */ }
    }
  });
}
