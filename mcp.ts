// MCP (Model Context Protocol, streamable HTTP) tools over the same store.
import type { Store } from './store.ts';

export interface McpToolDef { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] } }
const S = (t: string, desc: string): Record<string, unknown> => ({ type: t, description: desc });
export const MCP_TOOLS: McpToolDef[] = [
  { name: 'create_repo', description: 'Create a repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: S('string', 'Repository name'), description: S('string', 'Repository description'), private: S('boolean', 'Whether the repository is private') }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: S('string', 'Repository owner login'), repo: S('string', 'Repository name') }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: S('string', 'Repository owner login'), repo: S('string', 'Repository name'), title: S('string', 'Issue title'), body: S('string', 'Issue body') }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: S('string', 'Repository owner login'), repo: S('string', 'Repository name'), state: S('string', 'Issue state: open, closed, or all') }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: S('string', 'Repository owner login'), repo: S('string', 'Repository name'), title: S('string', 'Pull request title'), body: S('string', 'Pull request body'), head: S('string', 'Head branch name'), base: S('string', 'Base branch name') }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: S('string', 'Repository owner login'), repo: S('string', 'Repository name'), pull_number: S('integer', 'Pull request number') }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'get_issue', description: 'Get one issue by number.', inputSchema: { type: 'object', properties: { owner: S('string', 'Repository owner login'), repo: S('string', 'Repository name'), issue_number: S('integer', 'Issue number') }, required: ['owner', 'repo', 'issue_number'] } },
  { name: 'list_pull_requests', description: 'List pull requests in a repository.', inputSchema: { type: 'object', properties: { owner: S('string', 'Repository owner login'), repo: S('string', 'Repository name'), state: S('string', 'Pull request state: open, closed, or all') }, required: ['owner', 'repo'] } },
];

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: value, isError };
}
function errResult(message: string): Record<string, unknown> { return textResult(message, true); }

export function callMcpTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return errResult(`Unknown tool: ${name}`);
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') return errResult(`Missing required argument: ${req}`);
  }
  const owner = String(args.owner ?? store.viewer.login);
  const repoName = String(args.repo ?? args.name ?? '');
  try {
    switch (name) {
      case 'create_repo': {
        const repo = store.createRepo(String(args.name ?? ''), args.private === true, String(args.description ?? ''));
        if (!repo) return errResult(`Repository already exists: ${store.viewer.login}/${args.name}`);
        return textResult(repoJson(store, repo));
      }
      case 'get_repo': {
        const repo = store.getRepo(owner, repoName);
        if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
        return textResult(repoJson(store, repo));
      }
      case 'create_issue': {
        const repo = store.getRepo(owner, repoName);
        if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
        const created = store.createIssue(repo, String(args.title ?? ''), String(args.body ?? ''), []);
        if ('error' in created) return errResult(created.error);
        return textResult(issueJson(repo, created));
      }
      case 'list_issues': {
        const repo = store.getRepo(owner, repoName);
        if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
        const state = String(args.state ?? 'open');
        const list = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(repo, i));
        return textResult(list);
      }
      case 'get_issue': {
        const repo = store.getRepo(owner, repoName);
        if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
        const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
        if (!issue) return errResult(`Issue not found: #${args.issue_number}`);
        return textResult(issueJson(repo, issue));
      }
      case 'create_pull_request': {
        const repo = store.getRepo(owner, repoName);
        if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
        const created = store.createPull(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
        if ('error' in created) return errResult(created.error);
        return textResult(prJson(repo, created));
      }
      case 'merge_pull_request': {
        const repo = store.getRepo(owner, repoName);
        if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
        const pr = repo.pulls.find((p) => p.number === Number(args.pull_number));
        if (!pr) return errResult(`Pull request not found: #${args.pull_number}`);
        const res = store.mergePull(repo, pr);
        if ('conflict' in res) return errResult('Pull request is not mergeable (conflict).');
        return textResult({ merged: true, sha: 'already' in res ? res.already : res.sha, number: pr.number, state: pr.state });
      }
      case 'list_pull_requests': {
        const repo = store.getRepo(owner, repoName);
        if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
        const state = String(args.state ?? 'open');
        const list = repo.pulls.filter((p) => state === 'all' || p.state === state).map((p) => prJson(repo, p));
        return textResult(list);
      }
      default:
        return errResult(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return errResult(e instanceof Error ? e.message : String(e));
  }
}

export function repoJson(store: Store, repo: import('./store.ts').Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, id: store.viewer.id },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch, has_issues: true,
  };
}
export function issueJson(repo: import('./store.ts').Repo, issue: import('./store.ts').Issue): Record<string, unknown> {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: repo.owner }, created_at: issue.createdAt, updated_at: issue.updatedAt,
    html_url: '', url: '',
  };
}
export function prJson(repo: import('./store.ts').Repo, pr: import('./store.ts').Pull): Record<string, unknown> {
  return {
    id: pr.id, number: pr.number, title: pr.title, body: pr.body, state: pr.state, merged: pr.merged,
    merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: repo.owner }, created_at: pr.createdAt,
  };
}
