# makefun forge — github-core-clone-01 entry

A standalone, GitHub-compatible git forge in TypeScript, served by one Node 22 process from its
own in-memory store: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API
under `/api/v3`, GraphQL v4 at `/api/graphql`, and an MCP endpoint at `/mcp`. No dependencies, no
git binary, no network beyond the suite.

## Layout

| file | what it is |
| --- | --- |
| `main.ts` | the entry <-> env lifecycle (bind an ephemeral port, register, poll `/done`) |
| `app.ts` | the HTTP surface and routing across the four protocols |
| `store.ts` | git objects (blob/tree/commit/tag), refs, packs, the REST entities |
| `git.ts` | smart HTTP: v2 capability advertisement, `ls-refs`, `fetch` (+ shallow), v0 `receive-pack` |
| `rest.ts` | REST v3: repos, contents, branches, commits, labels, issues, comments, pulls, squash merge |
| `gql.ts` | a small GraphQL executor for the documents `gh` and `github-mcp-server` send |
| `mcp.ts` | JSON-RPC 2.0 over the Streamable HTTP transport, on the same store |

## Design notes

- **One store for every surface.** REST contents writes, GraphQL mutations, MCP tool calls and
  pushes all land in the same object database and ref map, so ids and objects read back unchanged
  from any of them.
- **Packs are written, not shelled out.** `writePack` emits a version-2 pack with base objects only
  and a sha1 trailer; `readPack` resolves ofs/ref deltas and finds each object's compressed length
  with an exponential-then-binary search over `zlib.inflateSync`.
- **Shallow fetches** are served from a generation-limited walk of the wanted commits: depth 1
  sends the tip's tree and blobs only and reports the tip as the boundary; a deepen moves the
  boundary and reports `unshallow` for the commit that is now complete.
- **Determinism.** No wall clock, no randomness: timestamps come from a monotonic counter fixed at
  the trial's opening date, so two runs leave the same bytes.

## Run

    node --experimental-strip-types main.ts

## License

MIT — see `LICENSE`.
