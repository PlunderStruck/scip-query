# slice-cohesion on Launchpoint (2026-09-03)

Repository: `launchpoint-backend` on the `dev-agent` box (7,917 TypeScript
files, index generation `63a96877fc5c`, checkout `d003e2e0`). Baseline is the
0.24.1 working-tree build that Codex reviewed; "after" is the build described
in the unreleased CHANGELOG entry. Wall-clock times are single runs from the
repository root with the watch service idle.

## Runtime

| Run                                            |               Before |                      After |
| ---------------------------------------------- | -------------------: | -------------------------: |
| `--scope .tsx -n 50 --json` (2,112 candidates) |        177 s, 2.5 GB |                8 s, 1.8 GB |
| `-n 20 --json` (2,500-candidate budget)        |         not recorded |                       22 s |
| `--full --json` (every candidate)              | stopped after 30 min | 33 s, 131 findings, 3.2 GB |
| targeted symbol                                |                 ~2 s |                       ~1 s |

Where the baseline time went (CPU profile of the `.tsx` run): TypeScript
parsing and binding of the standard library for every file (`scan`,
`doJSDocScan`, `bind`), automatic `@types` discovery and import resolution
through node_modules per program (`stat`, `tryParseJson`), `@typescript/lib-*`
replacement lookups, checker type inference for property-access symbols
(`getSymbolAtLocation`), and a reaching-definitions fixpoint that visited CFG
nodes in construction order (reverse program order) with string sets.

## Accuracy against the Codex review

| Codex item                                           | Outcome                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON `coverage.returned` always 1                    | rows counted; a targeted symbol reports complete, an uncapped scan reports complete, a capped report reports `total` and `omitted`                                                                               |
| "Complete flow coverage" overstates                  | `coverage.model = function-local-flow`, `candidateEdgeEffect = merge-only`; wording says local model                                                                                                             |
| "the seam is real"                                   | replaced by "local slices are disjoint"                                                                                                                                                                          |
| recommendations omit statements                      | recommendation lists the remainder, shared setup, sub-threshold clusters, and guard exits that stay in place                                                                                                     |
| cluster count vs. recommended functions              | every cluster carries a role: `remainder`, `extraction`, `below-threshold`                                                                                                                                       |
| imports, JSX tags, globals counted as inputs         | only parameters, `this`, shared setup, and enclosing-function locals are parameters                                                                                                                              |
| remainder penalized for a wide interface             | the largest cluster never needs an interface; tier depends on the extractions                                                                                                                                    |
| error handling as a second responsibility            | catch/finally statements depend on the try block (`runVideoApprovalSideEffects`, route handlers dropped)                                                                                                         |
| guard clauses and alternate returns                  | one return value per function, one output per returned field, log-then-exit branches are guards (`OnboardingPage`, `computeFatigueVerdict` dropped)                                                              |
| React effects and state resets split from the render | setter calls at render time or inside effects write the state the JSX reads (`ResolveDialog`, `CampaignPerformance`, `TaskReviewSurface`, `ActiveSectionProvider` dropped; `CampaignsClient` promoted to signal) |
| framework rules in wording                           | cluster kinds `calculation`, `hook`, `effects`; hook clusters are "custom hook candidates"                                                                                                                       |
| orchestration and scripts dominate                   | `orchestration` archetype at support tier; `scripts/`, `tools/`, `bin/`, `migrations/`, `integration-tests/` ranked last                                                                                         |
| output size                                          | scan rows omit units and slice arrays (React run 382 KB to 68 KB); targeted symbol keeps them                                                                                                                    |
| `--limit` does not bound work                        | `--scan-limit <n>`; help states the `--full`/`--limit` exclusion                                                                                                                                                 |
| no progress                                          | stderr progress every 2 s on a terminal, every 30 s when captured                                                                                                                                                |
| partial models still recommend a split               | a partial local model produces an inspection request instead                                                                                                                                                     |

React results after: `copyToClipboard`, `CampaignsClient`,
`CreateMetaCampaignForm`, `CreateTikTokCampaignForm` (signal);
`PropertiesEditor`, `RunAsAdPlatformCardOwner`, `VideoDuplicateComparer`
(support, wide interfaces). `PropertiesEditor` now partitions into two
clusters that each own their state declarations, effect, handlers, and
returned fields. `TikTokAdPreviewPanel` and `ManagedAdPublicationProgress`
no longer split because their effects write the state the render reads.

Not modeled, still disclosed: closure invocation order, cross-function
semantics, temporal coupling between effects, and finally blocks after an
abrupt completion.

## Second pass (2026-09-04, after Codex's rerun review)

Codex measured the first pass at 7.46 s for the React scope (16 support
findings to 4 signal and 3 support) and 20.7 s for the repository top-20,
and rated about three of four React signal findings and about half of the
repository recommendations as actionable. Remaining problems were
`copyToClipboard` (a modern attempt split from its fallback), repeated
`return empty` guards in `getCreatorApprovalDetails`, repeated log-then-
delegate suppression exits in `sendCreatorNotificationUseCase`, and "pure
calculation" labels on clusters that await services or query the database.

Changes: exit-only branches are structural (calls and local bindings
followed by a return or throw whose value is not computed in the branch or
an enclosing loop), every unit depends on its syntactically enclosing
predicates (the may-raise edges inside a `try` had removed the branch
dependence of `return true`), shared setup is judged against the partition
(a unit read by one cluster only returns to it), and clusters that await or
produce effects are `operation` candidates.

| Run                  |                                                                            Second pass |
| -------------------- | -------------------------------------------------------------------------------------: |
| `--scope .tsx -n 50` | 7 s, 5 signal + 2 support, complete coverage (2,112 candidates under the 2,500 budget) |
| `-n 20`              |                                                                                   21 s |

`copyToClipboard`, `getCreatorApprovalDetails`, `sendCreatorNotificationUseCase`,
and `validateAcceptCampaignPreconditions` no longer appear;
`resolveCreatorOfferState` is labeled an operation candidate; `CampaignsClient`
stays signal; `PropertiesEditor` rose to signal with the state declarations
inside each cluster instead of listed as parameters. The build reports
version 0.25.0 so it can be told apart from 0.24.1.

## Reproduction

Side install on the box (removed after the global refresh): `~/scipq-dev12/node_modules/scip-query` with
`dist` synced from a scratch tsup build (`--out-dir /tmp/scipq-dist`) and the
other entries symlinked from the global install. Outputs and CPU profiles
are under `dev-agent:/tmp/scb/` (`v8-react.json`, `v8-top20.json`,
`v8-full.json`, `cpu-v8-react/`). The global install was refreshed from a
tarball assembled from the same scratch dist.
