# 2026-07-02 Performance Architecture Ledger

## Output Contract

For the same repository state and command, optimized commands must keep the
same stdout SHA-256 unless a later step records explicit behavior-change
approval. Every benchmark row records the command, cache state, duration,
stdout/stderr byte counts, stdout SHA-256, `index.db` bytes, `evidence.db`
bytes, evidence row counts, git HEAD, and dirty status.

## Corpus Matrix

| Repo | Role | Baseline Target |
| --- | --- | --- |
| `Vega_2.0` | Large TypeScript/Python monorepo used to prove health and retro-gate scale. | health <= 8.0s warm, <= 14.0s evidence-cold; reindex <= 22.0s |
| `Stable_Management` | Medium app corpus used to prove cold reindex and warm detector budget. | reindex <= 10.0s; no warm detector command > 4.0s |
| `scip-query` | Tooling repo used to protect local development latency. | reindex <= 3.5s; health <= 1.5s |

## Cache States

| State | Meaning |
| --- | --- |
| `cold-index` | The active project index is removed before running the command. |
| `warm-index` | The active project index is reused without clearing evidence. |
| `evidence-cold` | Only `evidence.db` and its WAL/SHM siblings are cleared. |
| `evidence-warm` | Index and evidence DB are reused. |
| `retro-gate` | A historical commit is replayed in an isolated worktree/copy. |

## Run History Location

Machine-readable Plan 6 rows append to
`docs/benchmarks/runs/2026-07-02-performance-architecture.jsonl`. Profile JSONL
files live beside that run history and are summarized with
`scripts/profile-scoreboard.mjs`.

## Product Inventory

| Product Class | Shared Intermediate | Current Cache Tier | Profile Span | Hit/Miss Metadata | Shape | Owner Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| definition catalog | file definitions | `file_evidence:file-definitions` | definition catalog callers plus product wrapper | manifest records key parts; product hit spans are a follow-up | file-shaped | `src/symbols/definition-catalog.ts` |
| callee fingerprint | semantic callee rows | `semantic_callees` | `semantic.callees.compute-misses` | rows, misses, provider hits | semantic file/symbol-shaped | `src/symbols/graph/call-graph-evidence.ts` |
| git history | file-add records | `file_evidence:git-file-adds` | git-history product callers | manifest records HEAD/history key | git-shaped | `src/analysis/git-history.ts` |
| co-change | git history and changed files | no dedicated product yet | health/diff-gate git spans | not yet standardized | git/project-shaped | future gated step |
| source facts | AST-derived source facts | `file_evidence:source-facts` | source-facts product callers | manifest records content hash key | file-shaped | `src/source/source-facts.ts` |
| React | component behavior profiles | `file_evidence:react-component-behavior-profiles` | React profile callers | manifest records content hash key | file-shaped | `src/source/react-profile.ts` |
| Vue | source facts and Vue parser profile | no dedicated Vue behavior product yet | Vue source profile callers | not yet standardized | file-shaped | `src/source/vue-profile.ts` |

## Accepted Changes

| Step | Change | Evidence |
| --- | --- | --- |
| 6.0.1 | Added `scripts/performance-architecture-contract.mjs`. | Focused script tests pass; rebuilt validation run appended a `scip-query health --json` row with duration 2025ms and stdout SHA-256 `6edfdb367caf5c4660de76ea52fd6b2e4f0245edf8d235e749e60e1bede23705`. |
| 6.0.3 | Added `scripts/profile-scoreboard.mjs`. | Profile scoreboard grouped the rebuilt health profile; top spans were `dead.caller-map-supplement` at 1031ms and `semantic.callees.compute-misses` at 924ms. |
| 6.1.1 | Added evidence-product manifest and required invalidation metadata on product factories. | `tests/storage/evidence-products.test.ts` proves exact manifest coverage. |
| 6.1.2 | Added planted-stale coverage for representative existing tiers. | Existing `tests/storage/evidence-cache.test.ts` proves file, project, semantic callee, and semantic reference stale keys miss before rebuild/read. |
| 6.1.3 | Added cache invalidation matrix and checker. | `scripts/check-evidence-manifest-doc.mjs` validates that every manifest entry appears with a test path. |

## Rejected Changes

No optimization product was rejected in this slice. Later Plan 6 product
promotion remains gated by measured health spans and output-hash identity.

## Scoreboard

| Repo / Workload | Seed Before | Current Observed | Target | Status |
| --- | ---: | ---: | ---: | --- |
| `scip-query` `health --json` evidence-warm | ~1.2s | 2.025s on dirty tree | <= 1.5s | Regression candidate; profile shows caller-map and semantic callee spans dominate. |
| `scip-query` profile top span | not recorded | `dead.caller-map-supplement` 1031ms | lower after attribution | Measured |
| `Vega_2.0` `health --json` | 26.5s | not rerun in this slice | <= 8.0s warm | Pending |
| `Stable_Management` cold `reindex` | 13.9s | not rerun in this slice | <= 10.0s | Pending |

## Open Questions

- Should caller-map supplement work become the first promoted shared product,
  or is the dirty tree causing a misleading health split?
- Do semantic callee misses remain hot after a clean evidence-warm rerun with
  the rebuilt CLI?
- Should co-change evidence become a first-class git-shaped product, or should
  retro-gate measurement happen before adding that storage surface?
