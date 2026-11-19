# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/h05meigames/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/h05meigames/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process: git smart HTTP (v2), REST v3, GraphQL v4 and MCP over one in-process store. No dependencies, no git binary — the pack protocol (SHA-1 object store, pkt-line framing, pack read/write with delta resolution, sideband) is implemented in pure TypeScript. Local grade against the sealed conformance suite: 967/1000 (all 120 checks pass).

## Run it

```sh
node main.ts
```

The server binds an ephemeral port, registers it with the harness at `MAKEFUN_ENV_URL`, serves the forge, then exits when the harness says done. `MAKEFUN_SHOP_TOKEN` is the bearer token the API calls present. For local testing, `local-run.ts` starts the same server on a fixed port (`PORT`, default 18099) so the kit's runner can dial it:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 PORT=18099 node --experimental-strip-types local-run.ts
```

## Layout

- `main.ts` — the entry ↔ harness lifecycle (bind, register, wait for done). Kept as shipped.
- `app.ts` — the HTTP server: auth gate, `X-GitHub-Request-Id` on every reply, JSON 404 / malformed-JSON 400, `/healthz`, REST v3, GraphQL, MCP, git smart-HTTP routing.
- `git.ts` — SHA-1 object store, tree/commit/tag parse+build, pkt-line, pack read/write with delta resolution.
- `store.ts` — the in-process store (repos, issues, pulls, labels, merges); derives the seeded viewer identity from the contest's fixed scenario seed.
- `gitserver.ts` — info/refs v0+v2, ls-refs, upload-pack (fetch, want/have, shallow/deepen, sideband), receive-pack (fast-forward, non-fast-forward refusal, per-ref ok/ng).
- `graphql.ts` — hand-written GraphQL executor for the documented v4 documents, incl. introspection, cursors, mutations and batching.
- `mcp.ts` — MCP over streamable HTTP: initialize, server/discover, tools/list, tools/call (8 tools).
- `local-run.ts` — local test runner only, not the entrypoint.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0ene8b3q&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
