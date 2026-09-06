# Command audit results

The command-by-command pass is complete within the contracts recorded in the [ledger](../../benchmarks/command-contracts/2026-09-05/ledger.json). All 97 original entries have a decision: 11 removed and 86 retained. The retained registry has 81 publicly listed commands and five internal controls. Every retained command was exercised; successful execution alone was not the basis for retaining it.

“Verified within contract” means the producer and output claims were reviewed and the listed positive, negative and numerical examples passed. It does not mean every language construct, repository or possible execution has been validated. A candidate is a reported source or graph pattern that requires further inspection before changing code.

The [current inventory](../CURRENT_COMMANDS.md) gives every retained command's purpose. The [command reference](../COMMAND_REFERENCE.md) supplies its arguments. The [validation summary](../../benchmarks/command-contracts/2026-09-05/validation-summary.json) records the checks and limitations.

## Removed

| Commands | Decision |
| --- | --- |
| `wrapper-candidates`, `stale-abstractions` | Retire overlapping, weakly supported abstraction diagnoses. Retained forwarding and source evidence are more specific. |
| `complexity-hotspots` | Retire the composite score. Use documented function metrics and changed-function review. |
| `reference-neighborhood`, `reference-reachability` | Retire redundant reference projections whose relationships could be mistaken for executable reachability. |
| `extract-candidates`, `similar-chains` | Retire extraction/path advice based on insufficient local-flow evidence and silently bounded comparisons. |
| `self-audit` | Provider agreement did not establish independent correctness. Keep calibration in test tooling. |
| `value-flow` | Remove the redundant CLI wrapper; the typed dataflow provider and dependence slicing remain. |
| `isolated` | Remove the redundant cleanup surface. |
| `trace` | Remove the overlapping CLI, service and public query surface. Internal related-source assembly still supports `inspect` and `context`. |

TLA removal preceded this 97-command inventory. The retired commands reject ordinary execution. Commander can show root help for an unknown command followed by `--help`; that behavior is not evidence that the command exists.

## Repairs that materially change answers

- Call relationships now use compiler occurrence positions, including Unicode coordinate conversion. Name/chunk guesses remain candidates. Shadowing, aliases, recursive calls and rejected providers have regression witnesses.
- Source reads, symbol selection and reference lookup preserve exact identity. Ambiguous roots, stale named definitions, same-line siblings and unavailable source no longer silently produce stronger claims.
- Dependency and reference metrics use their stated counting units. Repeated calls within a stored chunk are not reported as separate stored references. Distinct file counts and dependency counts are not interchangeable.
- Diff impact unions observed consumer sources, selects actual changed hunks, preserves quoted Unicode Git paths, and compares the current worktree with the requested base. It discloses changed paths absent from the index.
- TS/JS complexity uses function-local syntax rules. Review compares changed/new functions against the base. Missing or mismatched test coverage cannot produce a CRAP result. Other supported estimates retain their declared basis.
- Similarity uses the complete selected callable, scopes dependency popularity correctly and preserves significant string literals. Duplication, signature comparison, import-use checks and cleanup cascade ordering received targeted fixes.
- First-use health reports source modules and dependency findings without requiring an index. Unmapped files, incomplete coverage and capped indexed candidate lists stay visible. Frontend checks account for full selected components and files.
- Setup, skill installation and uninstall preserve user-owned content and foreign links. Indexing validates languages and worker payloads. Vue augmentation binds actual indexed definitions and removes stale foreign references after local shadowing. Pagination preserves the immutable result and prints executable continuation commands.

Shared SCIP identity/range decoding now belongs to `src/domain`; Vue's index binding belongs to `src/reindex/augmentation`; shared reference-file counting belongs to `src/queries/internal`. The architecture policy explicitly permits augmentation to use the shared domain definitions. It does not permit the original cross-query imports, and the source module's file ceiling was not raised.

## Validation

| Check | Result |
| --- | --- |
| Full suite before final shared-code relocation | 2,870 passed; zero failed or skipped |
| Affected suites after relocation | 629 passed |
| General built CLI cases | 71 expected outcomes: 70 successful exits and one deliberate non-entry rejection |
| Independent compiler-fixture assertions | 42 passed |
| Setup/indexing/watch/suppression/internal-worker checks | 48 recorded invocations and assertions passed |
| Continuation/session checks | 58 recorded invocations and assertions passed |
| Real Vue indexing/binding checks | 7 passed |
| React/Vue detector checks | 34 passed |
| Configured architecture and Stop-hook checks | 8 passed |
| Retired-command rejection checks | 11 passed |
| Typecheck, formatting, ESLint, build, public API and skill links | Passed |

These counts overlap and use different units; they should not be added into one accuracy score. Controls, frontend and transport runs were recorded before the final behavior-preserving relocation; affected unit and real Vue/CLI checks were repeated afterward. The fixture and runners are saved alongside the ledger. Recreating the fixture from those saved files reproduced all 71 CLI outcomes and 42 claim assertions.

## Still open

The tool's own current-source review found **zero introduced or worsened architecture findings**, but **47 existing architecture findings and 67 introduced/worsened complexity findings** remain across the entire uncommitted checkout. That comparison includes earlier work and relocated functions. The exact complexity sites are saved in [self-review-findings.json](../../benchmarks/command-contracts/2026-09-05/self-review-findings.json). They are open maintainability work, not accepted exemptions or proof that these command results are wrong. No findings were suppressed to obtain a clean result.

The final impact run observed 800 changed symbols across 181 indexed changed files and 159 consumer files. It disclosed 947 changed paths absent or excluded from the index. Semantic consumer analysis was unavailable because 539 reference fragments were cold and the watcher was disabled; source fallback completed within its contract. This is not complete impact coverage.

Further work needs separate evidence: calibration on unfamiliar real repositories, broader language/framework coverage, and controlled coding-agent comparisons. No causal improvement in agent outcomes has been established by this audit. Similarity, drift, ownership pressure and cleanup advice still require checking the cited source and coverage before editing.
