# Detector guide

A detector is a repository analysis that selects source locations with a
shared evidence pattern. Compiler-graph detectors report resolved program
relationships. Heuristic detectors report candidates that require source
confirmation.

## Repository overview

```bash
scip-query health --full
```

The health report combines graph structure, duplication, drift, complexity,
history, suppressions, coverage contracts, and React and Vue analyses. Its
score is a summary, not proof of correctness.

## Focused detector families

| Concern                     | Commands                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Exact or near duplication   | `duplicate-bodies`, `similar`, `recent-duplicates`                                          |
| Parallel implementations    | `twin-drift`, `incomplete-migration`, `drift`                                               |
| Unused or disconnected code | `dead`, `isolated`, `unused-params`                                                         |
| Excess indirection          | `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `redundant-reexports` |
| Extraction seams            | `extract-candidates`                                                                        |
| Change pressure             | `complexity-hotspots`, `co-change`, `cycles`                                                |
| Documentation               | `doc-drift`                                                                                 |
| React                       | `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure`     |
| Vue                         | `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure`          |
| Team structure policy       | `architecture`                                                                              |

Run focused commands through the `scip-query` CLI. Add `--full` only when that
command supports it and exhaustive command coverage can change the decision.

## Acting on findings

1. Read the cited source.
2. Identify the shared concept or violated rule.
3. Preserve intentional variation.
4. Make one coherent edit.
5. Run native checks and the relevant detector again.
6. Use `scip-query diff-impact` when downstream consumers may have changed.

Suppress a false or accepted finding with `scip-query suppress <id>` and a
specific reason. A suppression addresses one finding; it must not disable an
unrelated detector family.

## Policy exclusions

Some rows match a detector's pattern because a convention demands the
match, not because anyone copied or wrapped anything. Detectors remove those
rows from the counts `health` scores and disclose the removal instead of
hiding it, under `Policy exclusions` in the text report and `policyExclusions`
in `health --json`. An excluded row is still listed by its focused command
(often at support tier), so a reviewer who disagrees with the policy can
still find it.

| Detector                                                                                | Excluded by policy                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure` | components in test files; pairs of vendored UI-kit primitives (the shadcn `components.json` `aliases.ui` directory or a `components/ui` directory); hook-versus-component pairs; loading placeholders that share only a skeleton primitive |
| `react-component-duplicates`                                                            | two framework route entries whose JSX overlaps (support tier: routing scaffolding); shared _behavior_ between route entries still counts                                                                                                   |
| `react-component-duplicates`, `react-hook-candidates`                                   | an intercepting route and its target are kept, with the recommendation to render one shared view                                                                                                                                           |
| `react-hook-candidates`                                                                 | pairs whose overlap is only generic React or data-fetching mechanics (`useState`, `useMutation`, `.mutate()`, `useRouter`)                                                                                                                 |
| `wrapper-candidates`                                                                    | constructors; single-consumer callables whose body computes or branches instead of forwarding one call (`bodyShape: helper`, signal tier)                                                                                                  |
| `duplicate-bodies`                                                                      | duplicate members that are constructors, test-file bodies, route-file verb exports, or vendored UI-kit bodies; a group must keep two product files to count                                                                                |
| `dead`                                                                                  | zero-reference symbols in framework entry surfaces (route handlers, pages, Trigger.dev task directories from `trigger.config.*`, live barrels) and in generated artifacts (`drizzle-kit pull` dumps, migration snapshots, codegen output)  |
| `twin-drift`                                                                            | route-file convention names (`handler`, `handleGet`, `*Page`, `generateMetadata`) inside framework entry files                                                                                                                             |
| `twin-drift`                                                                            | CRUD and lifecycle method names (`create`, `delete`, `getById`, `shutdown`, ...) declared directly on unrelated classes; free functions with those names keep the ordinary rules                                                           |
| `passthrough-candidates`                                                                | a file with three or more methods forwarding to the same collaborator is a facade; its forwards become boundary signals instead of direct inline advice                                                                                    |
| `co-change` (hidden coupling)                                                           | documentation that changes alongside the code it describes (`doc-drift` owns stale docs); generated artifacts such as migration journals, snapshots, and codegen output                                                                    |
| `complexity-hotspots` (extreme count)                                                   | callables above the extreme score only through fan-in, with fewer than 10 branches                                                                                                                                                         |
| `extract-candidates`                                                                    | regions whose extraction would take more than five locals in or hand more than two back (support tier: wide interface); only regions with a narrow or unknown interface count                                                              |
