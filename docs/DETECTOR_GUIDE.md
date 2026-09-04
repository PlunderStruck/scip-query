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
score is a summary, not proof of correctness. The `Input:` line under the
file and symbol counts names the index generation and the git commit,
branch, and uncommitted-path count the report was computed from
(`provenance` in `health --json`); compare two reports only when that line
matches, because a repository change and a detector change move the same
numbers.

## Focused detector families

| Concern                     | Commands                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Exact or near duplication   | `duplicate-bodies`, `similar`, `recent-duplicates`                                          |
| Parallel implementations    | `twin-drift`, `incomplete-migration`, `drift`                                               |
| Unused or disconnected code | `dead`, `isolated`, `unused-params`                                                         |
| Excess indirection          | `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `redundant-reexports` |
| Extraction seams            | `extract-candidates`, `slice-cohesion`                                                      |
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

| Detector                                                                                | Excluded by policy                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure` | components in test files; pairs of vendored UI-kit primitives (the shadcn `components.json` `aliases.ui` directory or a `components/ui` directory); hook-versus-component pairs; loading placeholders that share only a skeleton primitive                                        |
| `react-component-duplicates`                                                            | two framework route entries whose JSX overlaps (support tier: routing scaffolding); shared _behavior_ between route entries still counts                                                                                                                                          |
| `react-component-duplicates`, `react-hook-candidates`                                   | an intercepting route and its target are kept, with the recommendation to render one shared view                                                                                                                                                                                  |
| `react-hook-candidates`                                                                 | pairs whose overlap is only generic React or data-fetching mechanics (`useState`, `useMutation`, `.mutate()`, `useRouter`)                                                                                                                                                        |
| `wrapper-candidates`                                                                    | constructors; single-consumer callables whose body is not exactly one call with plain-value arguments (a preparatory statement, a callback, a nested call, or a literal the body builds makes it `bodyShape: helper`, signal tier)                                                |
| `duplicate-bodies`                                                                      | duplicate members that are constructors, test-file bodies, route-file verb exports, or vendored UI-kit bodies; a group must keep two product files to count                                                                                                                       |
| `dead`                                                                                  | zero-reference symbols in framework entry surfaces (route handlers, pages, Trigger.dev task directories from `trigger.config.*`, live barrels) and in generated artifacts (`drizzle-kit pull` dumps, migration snapshots, codegen output)                                         |
| `dead`                                                                                  | exports of source files a root configuration names by path (`next.config.js` `images.loaderFile`, `package.json` scripts)                                                                                                                                                         |
| `twin-drift`                                                                            | route-file convention names (`handler`, `handleGet`, `*Page`, `generateMetadata`) inside framework entry files                                                                                                                                                                    |
| `twin-drift`                                                                            | CRUD and lifecycle method names (`create`, `delete`, `getById`, `shutdown`, ...) declared directly on unrelated classes; free functions with those names keep the ordinary rules                                                                                                  |
| `twin-drift`                                                                            | a member that calls its same-name counterpart, directly or under an import alias (an operations function over its use-case, a component over the function it renders): a layer, not a parallel implementation                                                                     |
| `twin-drift`                                                                            | a thin forwarder whose single call is named differently from itself (a web API client, a vendor adapter) is a stub over its peer's concept; overrides of one abstract member; key-qualified lookup members (`getBySlug`, `findByEmail`) on unrelated classes                      |
| `passthrough-candidates`                                                                | a file with three or more methods forwarding to the same collaborator is a facade; its forwards become boundary signals instead of direct inline advice                                                                                                                           |
| `wrapper-candidates`, `passthrough-candidates`                                          | boundary terms are read from leaf names, and a term both sides carry (`toBaseRate` forwarding to `parseBaseRate`; a wrapper and its caller both under `lib/auth/`) is shared vocabulary, not a boundary; only asymmetric terms demote a finding to signal tier                    |
| `passthrough-candidates`                                                                | a class whose methods forward to members of three or more collaborators is a composed-service facade; a curried handler (`return jsonHandler(async () => {...})(req, res, next)`) is not a literal forward                                                                        |
| `wrapper-candidates`                                                                    | a forward through a module-private variable (`return loadedLanguages.has(lang)`) is a boundary signal because inlining would export the state                                                                                                                                     |
| `co-change` (hidden coupling)                                                           | documentation that changes alongside the code it describes (`doc-drift` owns stale docs); generated artifacts such as migration journals, snapshots, and codegen output                                                                                                           |
| `co-change`                                                                             | pairs whose shared commits were only broad sweeps, stale pairs with at most two focused co-changes, and configuration or schema partners (signal tier; listed by co-change)                                                                                                       |
| `co-change`                                                                             | a `<Name>.script.ts` companion is a component script block, not a maintenance script: a view script changing with its model is model-view coupling                                                                                                                                |
| `similar`                                                                               | two functions in one file sharing four or more callees at similarity 0.5 or more are direct whatever the vocabulary class; a cross-file pair whose shared evidence mixes domain behavior with scaffolding is direct from similarity 0.6; other scaffolding-only pairs stay signal |
| `cycles` (health axis)                                                                  | components that cycle through type or symbol references but not through imports; health counts import cycles and lists the rest as a disclosure, while the `cycles` command keeps its symbol-reference default and names the basis                                                |
| `complexity-hotspots` (extreme count)                                                   | callables above the extreme score only through fan-in, with fewer than 10 branches                                                                                                                                                                                                |
| `extract-candidates`                                                                    | regions whose extraction would take more than five locals in or hand more than two back (support tier: wide interface); only regions with a narrow or unknown interface count                                                                                                     |
| `extract-candidates`                                                                    | a selected region that is one statement (an awaited call with callback arguments, a resource or form declaration, a nested function) is support tier: extracting it would only wrap that statement; loop and branch bodies and rendered element subtrees keep their tier           |
