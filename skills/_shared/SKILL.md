---
name: _shared
description: Shared scip-query reference for bundled skills.
disable-model-invocation: true
---

# scip-query Shared Reference

This is shared reference for scip-query skills. Load it when another skill says to use the shared evidence, lookup, postcheck, or subagent rules.

## Evidence Contract

A SCIP index is the compiler-derived map of a repository's source files, symbols, references, imports, calls, and dependencies. What makes it different from text search is that it records what the language toolchain can identify, so code claims can point to definitions and consumers rather than matching strings.

A graph fact is a claim produced from that index, such as a definition line, reference site, caller, callee, dependency, reverse dependency, or affected consumer. Use graph facts for code behavior, ownership, and blast-radius claims.

Before trusting graph facts, run:

```bash
scip-query status --capabilities
```

If freshness is `fresh`, continue. If it is `stale`, `missing`, or `unknown`, run:

```bash
scip-query reindex
```

Every file path, line number, symbol relationship, and behavior claim in a plan, report, or review must cite the command that produced it. If `scip-query` cannot answer a question because the target is not indexed, say so and use the narrowest other evidence available.

## Lookup

Use partial symbol names without parentheses:

```bash
scip-query code parseConfig
scip-query call-graph runCommand
scip-query trace loadSettings
```

If lookup is ambiguous or missing:

1. Try a shorter symbol name.
2. Run `scip-query outline <file>`.
3. Run `scip-query trace <name>`.
4. Use `scip-query code 'path/to/file.ts:START-END'` when you know the file range.

## Command Families

<!-- BEGIN GENERATED COMMAND FAMILIES -->

This syntax catalog is generated from the CLI command descriptors.

### Indexing

```bash
scip-query reindex # Index the codebase and convert to SQLite
scip-query augment-sources # Add source files skipped by upstream SCIP indexers to the SQLite documents table
scip-query augment-vue # Add compiler-resolved Vue SFC references to the SQLite index using Volar
```

### Core

```bash
scip-query stats # Show index statistics
```

### Navigation

```bash
scip-query files <pattern> # Find files matching a pattern
scip-query methods <className> # List methods of a class (with line ranges)
scip-query refs <symbol> # Find all files referencing a symbol
scip-query trace <symbol> # Trace a symbol: definition + all references
scip-query deps <file> # Files this file depends on (internal)
scip-query rdeps <file> # Files that depend on this file/module
scip-query system <module> # Full module map: files, symbols, deps in/out
scip-query surface <module> # What symbols consumers actually use from this module
scip-query imports <file> # What symbols does this file import?
scip-query imported-by <symbol> # Which files import this symbol?
scip-query outline <file> # Tree view of symbols in a file, with line ranges
scip-query members <symbol> # All children of a symbol (methods, fields, nested types)
scip-query by-kind <kind> # Find symbols by SCIP kind (class, interface, enum, function, etc.)
scip-query kind-counts # Histogram of symbol kinds in the codebase
scip-query hierarchy <symbol> # Show a symbol's ancestry chain (method → class → module)
scip-query code <symbol> # Read the source code for a symbol (bounded to its definition range)
scip-query dataflow <symbol> # Reference-level dataflow: definition sites, usage sites, producers, consumers
scip-query slice <symbol> # Reference-level program slice: what affects this (backward) or what this affects (forward)
```

### Cleanup

```bash
scip-query dead [scope] # Find dead code and file-internal symbols (no cross-file consumers)
scip-query unused-imports <file> # Find imports not referenced in the same file
scip-query isolated # Find completely orphaned symbols (no references at all)
scip-query similar [symbol] [other] # Find heuristic function similarity candidates from callee fingerprints
scip-query similar-files [file] # Find heuristic similar-file candidates from dependency profiles
scip-query react-component-duplicates [file] # Find heuristic duplicated React component structure candidates from JSX tags, props, events, and bindings
scip-query react-hook-candidates [file] # Find heuristic React hook extraction candidates from shared state, effects, requests, and handlers
scip-query react-large-component-pressure [file] # Find heuristic large React component pressure candidates from component lines, JSX structure, and hook behavior
scip-query vue-component-duplicates [file] # Find heuristic duplicated Vue component structure candidates from template tags, bindings, slots, and directives
scip-query vue-composable-candidates [file] # Find heuristic Vue composable extraction candidates from shared state, effects, requests, and template bindings
scip-query vue-large-view-pressure [file] # Find heuristic large Vue view pressure candidates from template, script, style, and external script line counts
scip-query similar-chains # Find heuristic similar-chain candidates from dependency flows
scip-query extract-candidates # Find heuristic extraction candidates from isolated callee clusters
scip-query locality-candidates [symbol-or-file] # Find directory-locality and ancestry candidates from consumer ownership
scip-query cleanup-plan # Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks
scip-query cleanup-apply # Apply a compiler-verified cleanup-plan batch to the working tree
scip-query recent-duplicates # Directional duplicate candidates: recent code that re-implements established callable, React, or Vue code
scip-query doc-drift [doc] # Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped
scip-query unused-params # Speculative-generality candidates: trailing parameters no body ever uses (TS/JS)
scip-query drift [module] # Detect heuristic drift candidates: unused imports and layer violations by default; pass --patterns for pattern deviations too
scip-query wrapper-candidates # Find heuristic wrapper candidates only called by one consumer (high false-positive rate on codebases with intentional layering/ambient types — treat as exploration, not findings)
scip-query passthrough-candidates # Find heuristic passthrough candidates that forward to one callee
scip-query stale-abstractions # Find heuristic stale abstraction candidates with 0-1 consumers (high false-positive rate on codebases with intentional layering/ambient types — treat as exploration, not findings)
scip-query complexity-hotspots # Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out
scip-query convergence <symbol1> <symbol2> # Deprecated alias for similar <symbol1> <symbol2> --plan
scip-query redundant-reexports # Find barrel re-exports that nobody imports through
scip-query duplicate-bodies # Find exact duplicate small-body candidates across files
scip-query twin-drift # Twin drift candidates: same-name (or near-name) functions across files with diverged bodies
scip-query similar-signatures # Find functions with near-identical type signatures (same shape)
```

### Graph

```bash
scip-query hotspots # Most-referenced symbols in the codebase (choke points)
scip-query fan-in [symbol] # How many files reference a symbol (or top fan-in across codebase)
scip-query fan-out [file] # How many external symbols a file uses (or top fan-out across codebase)
scip-query coupling [file1] [file2] # Coupling between two files, or top coupled pairs in codebase
scip-query cycles # Detect circular dependency chains between files
scip-query bottlenecks # Find coupling hubs: high fan-in AND high fan-out
scip-query deep-chains # Find the longest transitive dependency chains
scip-query call-graph <symbol> # Show incoming callers and outgoing callees for a symbol
```

### Impact

```bash
scip-query affected <symbol> # Transitive closure of symbols that could break if this symbol changes
scip-query change-surface <file> # Pre-change briefing: exports, consumers, and blast-radius risk
scip-query co-change [file] # Files that change together in git history without a dependency edge — hidden coupling candidates
scip-query diff-gate # Gate the current diff: echo candidates, incomplete migrations, missing co-change partners, unedited twin partners (advisory), uncited doc updates, unused params, new dead symbols; exit 1 on blocking findings
scip-query incomplete-migration # Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain
scip-query diff-impact # Compute changed symbols and downstream consumers from current git diff
```

### Formal Models

```bash
scip-query tla <operation> [spec] # TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation
```

### Planning

```bash
scip-query plan-context <target> # Pre-edit planning context for a symbol, file, or module
```

### Health

```bash
scip-query self-audit # Score cheap evidence paths against the best available semantic/source oracle on sampled symbols
scip-query health # Composite codebase health report with prioritized action list
scip-query complexity <symbol> # Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees
```

### Maintenance

```bash
scip-query bench # Benchmark indexing and command runtimes for this repository
scip-query install-skills # Install skills (_shared, scip-query, scip-setup, scip-cleanup-audit, scip-cleanup-improve, scip-twin-drift, scip-claim-audit, scip-probe-reachability, scip-hyper-optimization, scip-api-impact, concrete-plan, scip-debug, scip-explore, scip-triage-issue, scip-diagram, scip-doc-reconcile, scip-directory-architecture, scip-maintainability, scip-react-maintainability, scip-vue-maintainability, scip-verify, scip-language-playbook, tla-model-system) into Claude Code, Codex, and shared agent roots
scip-query setup-hooks # Install or refresh project-local Codex and Claude Code lifecycle hooks
scip-query check-deps # Check whether scip-query and the detected language indexers are actually runnable
scip-query capabilities # Report which evidence and verification capabilities are available in this project
scip-query capability-matrix # Deprecated alias for capabilities --matrix
scip-query init # Create a .scipquery.json config file for this project
scip-query config-validate # Validate .scipquery.json, including structured suppressions and declared coupling groups
scip-query suppress <id> # Record an accepted finding in .scipquery.json with a required reason
scip-query doctor # Diagnose config, index freshness, dependency readiness, and project capabilities
scip-query setup # Bootstrap this project: install agent skills, refresh the index, verify capabilities, and report health
scip-query setup-agent # Seed agent guidance for this project: AGENTS.md/CLAUDE.md block pointing agents at the scip-query skills and diff gate, plus an optional git pre-commit backstop
scip-query setup-ci # Write a GitHub Actions workflow that runs scip-query reindex and diff-gate on pull requests
scip-query uninstall # Remove scip-query-owned skill links, project hooks, and managed agent setup blocks
scip-query watch # Watch for file changes in the foreground and reindex automatically
scip-query status # Show index status for this project
```

<!-- END GENERATED COMMAND FAMILIES -->

## Detector Reliability

Calibrated against two external production repos on 2026-07-01
(docs/validation/2026-07-01-external-calibration-*.md). Weight findings by
measured precision, not by volume:

- **Strong signal** — `complexity-hotspots` (~90%), `recent-duplicates` (~75%), graph facts (`refs`, `trace`, `deps`), compiler-verified `cleanup-plan --verify`.
- **Good with review** — `duplicate-bodies`, `similar`, `co-change`, `doc-drift`, `twin-drift` (post-retune defaults).
- **Exploration only** — `wrapper-candidates`, `stale-abstractions`, `drift --patterns`: near-zero precision on codebases with intentional layering or ambient types. Never file their findings without reading the cited code.
- **Advisory gate findings** (marked `(advisory)`) never block; they are context, not obligations.
- **Known false-dead archetypes**: `dead`/`new-dead` currently over-report on symbols consumed only via `import type`, pnpm-workspace cross-package consumers, and Vue `<script setup>` composables (docs/plans/2026-07-02-followups.md items 1-3). On repos with those shapes, confirm with `refs` and trust `cleanup-plan --verify` over raw `dead` output.
- **Ledger nudges**: when `diff-gate --hook` reports "this check is rarely acted on in this repo", either tune that check's config, suppress the standing findings with reasons, or consciously accept the noise — do not let unresolved findings accumulate as wallpaper.

## Postchecks

Run the rows that match the actual edit:

| Change made | Check |
| --- | --- |
| Extracted a helper or abstraction | `scip-query incomplete-migration --json --full` |
| Added a helper, module, component, hook, composable, or adapter | `scip-query similar <symbol> --json --full` and `scip-query recent-duplicates --json --full` |
| Added parameters, options, props, config flags, or broad option objects | `scip-query unused-params --json --full` |
| Added a wrapper, facade, forwarding layer, alias, or re-export | `scip-query wrapper-candidates --json --full`, `scip-query passthrough-candidates --json --full`, and `scip-query redundant-reexports` when exports changed |
| Added an interface, base class, adapter contract, or type alias | `scip-query stale-abstractions --json --full` |
| Changed schema, config, generated files, public contracts, command descriptors, or docs-backed behavior | `scip-query co-change <file> --json --full` and `scip-query doc-drift --json --full` |
| Deleted code | `scip-query cleanup-plan --verify --json` |
| Changed React components or hooks | the React frontend commands above |
| Changed Vue SFCs or composables | the Vue frontend commands above |

Every implemented change ends with:

```bash
scip-query status --capabilities
scip-query diff-gate --json
```

Fix findings or record a specific acceptance reason. Do not report success while a diff-gate finding is unexplained.

## Subagents

When a subagent is used for scip-query evidence, include these rules in its prompt:

```text
Use scip-query for all code references. Do not use grep, rg, cat, or file reads as evidence for code behavior. Every file path, line number, and behavioral claim must cite the exact scip-query command that produced it. If scip-query cannot verify a claim, say so.
```

Reject subagent findings that cite text search or raw file reads as code evidence when graph facts were required.
