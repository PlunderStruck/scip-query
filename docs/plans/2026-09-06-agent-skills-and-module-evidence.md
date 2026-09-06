# Agent skills and module evidence

## Outcome and authorization

The user requested consolidating agent skills, retaining an integrity investigation that detects incomplete or misleading implementations, and providing one coherent module evidence view. Work directly on main. Preserve the unrelated untracked LaunchPoint validation report. This plan records scope and progress across context resets.

Success means agents have a small set of distinct workflows for exploration, planning, architecture/maintainability review, integrity review, and tool operations; module evidence exposes observed structure and recoverable source without pretending to infer business ownership or a design score.

## Initial evidence

- `src/runtime/setup.ts:21` installs two default skills and lists fourteen installable names. Some names overlap or are aliases.
- `skills/scip-integrity-audit/SKILL.md` contains valuable negative-case, real-input, fallback, metric, and parallel-implementation investigations, but prescribes all drills regardless of the actual claim and overstates some detector evidence.
- Architecture/maintainability guidance is split between principal-maintainability-review, scip-system-compression, scip-root-cause, and scip-twin-drift. Status/parser/detector investigation is split between integrity, claim-audit, probe-reachability, and calibrate.
- `system <module>` currently returns indexed matching files, symbols, outgoing file reference dependencies, and incoming consumers. `architecture` aggregates configured import boundaries. Neither alone establishes a business responsibility or architectural quality.
- Existing source `health` supports first-use TS/JS scanning without an index but displays subjects with findings, not a complete module inventory.
- `.scipquery.json` already supports boundaries, allowedDependencies, complete policy/coverage, and cycle checks. Those rules preserve decisions; compliance does not establish their quality.

## Work ledger

| Step | Owners / files | Required behavior | Validation | State |
| --- | --- | --- | --- | --- |
| 1. Map integration and evidence owners | setup, skill generators/checkers, system/context query and renderers, related tests | Identify install, packaging, generated instructions, output, coverage, and API consumers before editing | Exact source and consumer inventory | Complete |
| 2. Consolidate skills | skills/, setup, active docs and generators | Six canonical skills: scip-query, scip-explore, scip-plan, scip-architecture-review, scip-integrity-audit, scip-setup. Fold useful specialist drills into references; retire overlapping entry points and alias. No blanket detector battery or score chasing | Skill links/command checks; installer upgrade tests; read retained examples against current commands | Complete |
| 3. Provide coherent module evidence | source/ast/function-metrics.ts; queries/health/source-system.ts and source-modules.ts; runtime/query-commands/source-system.ts; cli-main.ts | Explicit system --source mode; retain indexed system path and API. Share health snapshot/analysis and parsed export collection. Include clean groups, relationships, policy, findings, and exact recovery | Known-answer cases including unconfigured repo, clean modules, cross-boundary deps, unsupported interfaces, and bounded output | Complete |
| 4. Integrate agent guidance | Generated AGENTS/CLI docs and skills | Orient → investigate named concern → plan → implement → review actual diff and behavior. Distinguish syntax trees from resolved identity and observed execution | Generated docs and command contract checks | Complete |
| 5. Verify and close | Focused tests, build, lint/types as appropriate, architecture/review/diff-impact | Preserve existing interfaces where practical; detect bad inputs and missing implementation; record limits and actual check results | Targeted tests then required repository checks; current-source review and indexed impact | Complete |

## Design requirements

- Optimize for mistakes agents make: selecting the wrong owner, creating a parallel implementation, leaking coordination into callers, trusting decorative checks, and claiming completion while a fallback still does the work.
- A syntax tree represents parsed constructs; compiler identity establishes which declaration a reference names; execution evidence establishes a path actually ran. None substitutes for the others.
- Integrity review derives expected behavior from the user requirement and actual consumers. A regex is not automatically a defect; using text heuristics to claim grammar/binding guarantees is. A parser wrapper that delegates to the old heuristic is not a completed migration.
- Architecture review combines structural facts with source and consumers. Deep interfaces reduce required caller knowledge, not merely argument/export counts. Shared lifecycle/state and intentional adapters are counterevidence to simplistic split/merge rules.
- Module grouping is explicit: configured boundary or provisional directory/package grouping. First-use inventory includes groups without findings. Runtime relationships and excluded source remain disclosed gaps.
- Review breadth is recorded separately from scan breadth. A whole-repository map must not be described as a whole-repository behavioral audit.
- No automatic policy relaxation, automatic consolidation, new overall score, or mandatory full-suite repetition for each small edit.

## Validation record

Baseline branch is main at 96b9a870; working tree had only the unrelated LaunchPoint report before this plan was added. Nine retired skill directories were removed; six workflows are now the default and full install set. The shipped-directory coverage contract now targets the single authoritative BUILTIN_SKILLS array, rather than an install-list copy.

The six skill entrypoints total 3,678 words, down from 17,023 (78.4% less). Architecture and integrity retain focused reference material. Setup preserves user-owned skill links/files and removes links into this package for retired skills. The TypeScript public API check remains unchanged; SourceModuleSubject still requires a finding priority, while the new inventory type also represents clean groups.

Known-answer tests in tests/queries/health/source-system.test.ts exercise unconfigured inventories, clean groups, boundary policy, outside consumers, type/deferred/test imports, parsed exports, parse/missing-import and scan limits, human recovery, legacy dispatch, normalized import references, and actual built CLI execution in a fresh repository. A final case covers nested destructured exports (aliases, defaults, rest, array holes), using the existing binding-name traversal moved from slice cohesion into the existing source/ast/maintenance-bindings.ts owner.

Validation completed before the final startup-policy extraction and binding-name move:

- Full regression suite: 2,920 passing tests in 342 files; no failures.
- Build, required typechecks, formatting, ESLint, public API surface/consumer, generated command docs, and skill links passed.
- Refreshed compiler index: 557 files; architecture maps all 557 with all 47 policy rows declared. No forbidden edges, cycles, unused allowances, boundary-limit violations, or test-boundary violations. No architecture allowances or thresholds were widened.
- Current-source diff review: 560 eligible files analyzed; no blocking or introduced findings. An anonymous startup callback was uncomparable because two callbacks share its generated name. Manual before/after comparison found three added decisions; the new source-mode decision was extracted into commandPreparation, restoring the original hook complexity. Uncomparable results must not be interpreted as unchanged.
- Fresh diff impact now includes both new query/runtime files. Semantic consumer coverage remains unavailable with cold reference fragments and no running watcher; source-fallback consumer analysis completes. Documentation, skills and excluded test paths remain outside symbol analysis. This is a recorded limit, not a claim of exhaustive symbol consumers.

LaunchPoint source-mode validation captured all 5,632 eligible TS/JS files: 1,385 groups, 915 groups without findings, 33,000 import observations, 7,239 cross-group production edges, and 24,826 export declarations. Coverage was accounted with no source/configuration problems. Only 28 files belong to configured architecture boundaries; 5,604 remain provisional directory members. These are observed groups, not inferred business owners.

The first exhaustive LaunchPoint export exceeded the 32-million-character output safety limit because import records were repeated in groups and edges. The report now stores imports once and uses report-local numeric references. The same whole-repository export succeeds at 28,370,044 bytes on the final scanner run (19.17 seconds). Large machine reports belong in artifacts; human output remains bounded with recovery. This does not remove global output or source-snapshot limits.

The initial standalone binding helper exceeded the existing source boundary file limit (68 versus 67). It was folded into the existing binding-analysis owner; no limit was raised. Both compiler providers use the shared traversal. Local installation now links the six canonical skills in Claude, Codex and shared agent roots; three stale concrete-plan links were pruned. Other package-owned legacy-link removal is covered by the upgrade tests.

Final validation after the refinements:

- 119 targeted tests passed across 8 files, including all source-system cases, function metrics, maintenance bindings, slice cohesion, source review, installer upgrade, generated agent guidance and CLI contracts. The full-suite result above predates these final refinements; the affected tests were rerun afterward.
- Build, required typechecks, formatting, ESLint, public API surface and consumer, skill links, and Git whitespace checks passed.
- Current-source review is accounted with no blocking, introduced, or worsened findings. The shared-name callback remains explicitly uncomparable; manual comparison confirms its original cyclomatic 22 and cognitive 25 values were restored.
- The final refreshed architecture graph again maps all 557 indexed files, has all 47 policy rows, and reports zero forbidden edges, cycles, stale allowances, boundary-limit violations or test-boundary violations.
- Final diff impact maps 43 changed symbols across 13 changed implementation files and 29 affected files. No changed src/ path is unindexed. Source-fallback consumers complete; semantic consumers retain the cold-cache/no-watcher limitation described above. The 46 omitted paths are documentation, skills, configuration and excluded tests, including the unrelated untracked report.

Implementation and required verification are complete. The controlled agent-task evaluation below remains future work, not a prerequisite hidden by these test results.

No comparative agent-task benchmark was run for the rewritten skills. Passing tool tests and scanning a real repository do not establish that agents produce better changes; that requires a subsequent controlled task comparison, preferably using the cheaper model requested earlier.
