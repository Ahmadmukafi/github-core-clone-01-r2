# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ahmadmukafi/github-core-clone-01-r2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ahmadmukafi/github-core-clone-01-r2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: **one process, no UI, no git binary, own store**. Built for the [make.fun](https://make.fun/competitions/github-core-clone-01) bounty `github-core-clone-01` — round 2, a performance pass over the round-1 entry (local kit-runner score ~984/1000, the only gap being Perf).

Join make.fun with my referral: https://make.fun/r/6z0bn4hz (code `6z0bn4hz`).

## What it serves

- **Git smart HTTP** — upload-pack v2 (`ls-refs`, `fetch` with depth/shallow, filters) and receive-pack v0 (`report-status`, side-band-64k, non-fast-forward rejection), packfiles v2/v3 with OFS/REF delta resolution, SHA-1 object format.
- **REST v3** under `/api/v3` — repos, issues, pull requests (three-way merge), labels, comments, branches, commits, contents, git refs/tags; bearer auth via `MAKEFUN_SHOP_TOKEN`; every reply carries `X-GitHub-Request-Id`.
- **GraphQL v4** at `/api/graphql` — viewer, repository, node, `__type` introspection, Relay global ids, cursor pagination, batching, and the mutations `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment`.
- **MCP** at `/mcp` — JSON-RPC 2.0, `server/discover` (protocol 2026-07-28) plus the legacy `initialize` fallback, and six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## Run it

```bash
node --experimental-strip-types main.ts
```

Node 22+, standard library only, no dependencies. The entry binds an ephemeral port, `POST`s `{"port": n}` to `$MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done` and exits 0 when the suite is over. Without `MAKEFUN_ENV_URL` it serves standalone on `$PORT` (or the ephemeral port) and prints the URL.

```bash
MAKEFUN_SHOP_TOKEN=secret node --experimental-strip-types main.ts
```

## Layout

```
main.ts            entrypoint: bind, register, poll /done
src/
  util.ts          deterministic clock, SHA-1, base64, Relay ids
  objects.ts       git objects, packs, delta resolution, fetch planning
  pkt.ts           pkt-line framing
  store.ts         in-memory store: repos, issues, PRs, labels, contents
  git.ts           smart HTTP: advertisement, upload-pack v2, receive-pack v0
  rest.ts          REST v3 routes
  graphql.ts       GraphQL parser + executor
  mcp.ts           MCP JSON-RPC server and tools
  server.ts        HTTP router (healthz, git, REST, GraphQL, MCP)
```

## Speed

Round 2 keeps the round-1 API surface byte-for-byte and only makes the hot paths faster:

- pack cache keyed by `(wants, haves, depth, shallow)` — the clone benchmark's 50 concurrent depth-1 clones of one tip share one pack;
- cached `ls-refs` and ref-advertisement buffers per repo version;
- cached serialized REST JSON for repos and issues, invalidated only by PATCH;
- zlib level 1 for pack deflate, one `Buffer.concat` per pack;
- deterministic, allocation-light parsers (no regex in the hot paths, no `Date.now()`/`Math.random()` in stored data — the clock ticks from the fixed scenario epoch).

## License

MIT — see [LICENSE](LICENSE).
