# Full command-family vocabulary

Every command the scip-query CLI exposes. Commands marked ★ have a usage scenario in `SKILL.md` — treat this table as the index, not the reasoning. The catalog itself is generated from the CLI's command descriptors, not hand-maintained prose; if a command here looks stale, regenerate rather than hand-edit.

## Index lifecycle
- `reindex` ★ — indexes the codebase and converts it to SQLite.
- `augment-sources` — adds source files skipped by upstream SCIP indexers to the documents table.
- `augment-vue` — adds compiler-resolved Vue SFC references to the index using Volar.
- `status` ★ — index status for this project (freshness, capabilities).
- `stats` ★ — index statistics.
- `watch` — watches in the foreground, or manages the per-project background refresh service.

## Lookup and reading
- `files <pattern>` ★ — find files matching a pattern.
- `methods <className>` — list methods of a class with line ranges.
- `refs <symbol>` ★ — find all files referencing a symbol.
- `trace <symbol>` ★ — a symbol's definition plus all references.
- `outline <file>` ★ — tree view of a file's symbols with line ranges.
- `members <symbol>` ★ — every child of a symbol (methods, fields, nested types).
- `by-kind <kind>` ★ — find symbols by SCIP kind.
- `kind-counts` ★ — histogram of symbol kinds in the codebase.
- `hierarchy <symbol>` ★ — a symbol's ancestry chain, method to class to module.
- `code <symbol>` ★ — read the source for a symbol, bounded to its definition range.
- `imports <file>` ★ — what symbols a file imports.
- `imported-by <symbol>` — which files import this symbol.

## Semantics and structure
- `dataflow <symbol>` ★ — reference-level dataflow: definitions, usages, producers, consumers.
- `slice <symbol>` ★ — reference-level program slice, backward or forward.
- `deps <file>` ★ — files this file depends on (internal).
- `rdeps <file>` ★ — files that depend on this file/module.
- `system <module>` ★ — full module map: files, symbols, deps in/out.
- `surface <module>` ★ — symbols consumers actually use from a module.

## Dead code, duplication, and cleanup heuristics
- `dead [scope]` ★ — repository-dead code, file-internal symbols, implicit-usage signals.
- `unused-imports <file>` — imports not referenced in the same file.
- `isolated` ★ — completely orphaned symbols with no references at all.
- `similar [symbol] [other]` ★ — heuristic function similarity from callee fingerprints.
- `similar-files [file]` ★ — heuristic similar-file candidates from dependency profiles.
- `similar-chains` — heuristic similar-chain candidates from dependency flows.
- `extract-candidates` — heuristic extraction candidates from isolated callee clusters.
- `locality-candidates [symbol-or-file]` — directory-locality/ancestry candidates from consumer ownership.
- `cleanup-plan` — ordered, batched deletion plan: graph-fact dead code plus cascade candidates it unlocks.
- `cleanup-apply` — applies a compiler-verified cleanup-plan batch to the working tree.
- `recent-duplicates` — directional duplicate candidates: recent code re-implementing established code.
- `doc-drift [doc]` — stale-doc candidates: cited code, or co-changed code that kept changing after the doc stopped.
- `unused-params` — speculative-generality candidates: trailing parameters no body uses (TS/JS).
- `drift [module]` — unused imports and declared architecture violations; pass `--architecture` for boundary context.
- `wrapper-candidates` — heuristic wrapper candidates called by one consumer. **Exploration only** — see precision tiers.
- `passthrough-candidates` — heuristic passthrough candidates that forward to one callee.
- `stale-abstractions` — heuristic candidates with 0-1 consumers. **Exploration only** — see precision tiers.
- `complexity-hotspots` — heuristic complexity hotspots from LOC × fan-in × fan-out. Strong signal, ~90% precision.
- `convergence <s1> <s2>` — **deprecated**, alias for `similar <s1> <s2> --plan`; prefer the latter.
- `redundant-reexports` — barrel re-exports nobody imports through.
- `duplicate-bodies` — exact duplicate small-body candidates across files.
- `twin-drift` — same-name (or near-name) functions across files with diverged bodies.
- `twin-ab <symbolA> <symbolB>` — generates a behavioral A/B vitest scaffold comparing two same-concept twins; a ready-to-fill file, not an auto-executor.
- `not-implemented` — reachable placeholder stubs (throw-stub, TODO+return-default, empty body) with a real production caller; an unreachable stub belongs to `dead` instead.
- `decorative-checkers` — validate*/verify*/check*/assert*/is*/has* callables with no reachable failure exit.
- `test-quality` — assertion-free test bodies, a skipped-test ledger with git-blame age, mock-echo tests.
- `similar-signatures` — functions with near-identical type signatures.

## React / Vue heuristics
- `react-component-duplicates [file]` — duplicated JSX structure candidates (tags, props, events, bindings).
- `react-hook-candidates [file]` — hook-extraction candidates from shared state/effects/requests/handlers.
- `react-large-component-pressure [file]` — large-component-pressure candidates from lines, JSX structure, hooks.
- `vue-component-duplicates [file]` — duplicated template structure candidates (tags, bindings, slots, directives).
- `vue-composable-candidates [file]` — composable-extraction candidates from shared state/effects/requests/bindings.
- `vue-large-view-pressure [file]` — large-view-pressure candidates from template/script/style/external line counts.

## Coupling, architecture, impact
- `hotspots` — most-referenced symbols in the codebase (choke points).
- `fan-in [symbol]` ★ — files referencing an exact symbol; top JSON rows include exact symbol identity.
- `fan-out [file]` ★ — external symbols a file uses, or top fan-out codebase-wide.
- `coupling [file1] [file2]` ★ — coupling between two files, or top coupled pairs codebase-wide.
- `cycles` ★ — circular dependency chains between files.
- `architecture` ★ — evaluates project-owned architectural boundaries and dependency rules.
- `bottlenecks` ★ — high fan-in AND high fan-out symbols/files.
- `deep-chains` — longest condensed dependency-component chains.
- `call-graph <symbol>` — incoming callers and outgoing callees for a symbol.
- `affected <symbol>` — transitive closure of symbols that could break if this symbol changes.
- `change-surface <file>` — pre-change briefing: exports, consumers, blast-radius risk.
- `co-change [file]` ★ — files that change together in git history without a dependency edge.

## Diff, migration, formal modeling
- `diff-gate` — gates the current diff; see `detector-precision-and-diffgate.md` for its ten checks.
- `incomplete-migration` — partially-completed extraction candidates left un-migrated at similar sites.
- `diff-impact` — changed symbols and downstream consumers from the current git diff.
- `tla <operation> [spec]` — TLA+ workflow: verify a model/mapping contract, scaffold a draft model, generate a trace recorder, or check a recorded trace against the next-state relation.
- `plan-context <target>` — pre-edit planning context for a symbol, file, or module.

## Health, complexity, performance
- `self-audit` — scores cheap evidence paths against the best available semantic/source oracle on sampled symbols.
- `health` — composite codebase health report with a prioritized action list.
- `complexity <symbol>` — per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees.
- `bench` — benchmarks indexing and command runtimes for the repository.
- `work-audit <profile>` — ranks exact repeated computations in a profiling JSONL file by measured avoidable time.

## Setup, config, governance
- `install-skills` — installs the 27-skill scip-query set into Claude Code, Codex, and shared agent roots.
- `setup-hooks` — installs or refreshes project-local Codex and Claude Code lifecycle hooks.
- `check-deps` — checks whether scip-query and detected language indexers are actually runnable.
- `capabilities` — reports which evidence/verification capabilities are available in this project.
- `capability-matrix` — **deprecated**, alias for `capabilities --matrix`; prefer the latter.
- `init` ★ — creates `.scipquery.json` for this project.
- `config-validate` ★ — validates `.scipquery.json`, including suppressions and declared coupling groups.
- `suppress <id>` ★ — records an accepted finding under `.scipquery/suppressions/` with a required reason.
- `effectiveness` ★ — per-check effectiveness from the committed outcome ledger.
- `doctor` — diagnoses config, index freshness, dependency readiness, project capabilities.
- `setup` — bootstraps a project: automatic indexing, agent skills, index refresh, capability check, health report.
- `setup-agent` — seeds an AGENTS.md/CLAUDE.md block pointing agents at the scip-query skills and diff gate, plus an optional git pre-commit backstop.
- `setup-ci` — writes a GitHub Actions workflow running `reindex` and `diff-gate` on pull requests.
- `uninstall` — removes scip-query-owned skill links, project hooks, and managed agent setup blocks.

## General rule on coverage

Each command's returned set is either complete (exhaustive) or bounded (capped/sampled). Where that isn't stated explicitly for a given command, assume bounded and say so before treating the result as proof of completeness — a bounded result narrows, it does not exonerate.
