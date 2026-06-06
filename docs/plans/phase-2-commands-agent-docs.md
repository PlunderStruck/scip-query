# Implementation Plan: Phase 2 Commands + Agent Documentation

This plan adds 10 new analysis commands and a comprehensive agent usage guide. Organized into 4 phases to keep diffs bounded and independently testable.

---

## Phase 1: Transitive Impact + Change Planning (3 commands)

These serve Use Case 1 — deep understanding for concrete planning.

### 1.1 `affected <symbol>`

**Purpose:** Full transitive closure of symbols that could break if a given symbol changes. Walks rdeps recursively at the symbol level (not just file level like `rdeps`).

**Implementation:**
- New file: `src/queries/affected.ts`
- Algorithm: BFS from the target symbol through the mention graph. For each symbol that references the target, find symbols that reference *that* symbol, and so on. Track depth. Cap at configurable max depth (default 5) to avoid full-graph traversal on hub symbols.
- Reuse: `findFirstSymbolMatch()` from `query-support.ts` to resolve the target.
- SQL core: Recursive walk on `mentions` (role=0) → `defn_enclosing_ranges` → back to `mentions`. Each hop finds the enclosing symbol of each reference site, then finds references to *that* symbol.
- Output type: `AffectedResult` — array of `{ symbol, shortName, file, depth }` sorted by depth then file.
- CLI: `scip-query affected <symbol> [--max-depth N] [--scope path]`

**Value:** "If I change this function's signature, what's the full blast wave?" Direct rdeps are depth 1. Their consumers are depth 2. This shows the full picture.

### 1.2 `change-surface <file>`

**Purpose:** Pre-change briefing: "I'm about to modify this file. What do I need to know?"

**Implementation:**
- New file: `src/queries/change-surface.ts`
- Composes existing queries internally — not a raw SQL query but an orchestrator:
  1. Call `symbols()` to get all symbols in the file
  2. For each symbol, call the refs logic to count external consumers
  3. Call `testCoverage()` to check which symbols are test-covered
  4. Call `fanIn()` to get reference counts
- Output type: `ChangeSurfaceResult` — per-symbol: `{ symbol, shortName, externalConsumers: number, testFiles: string[], riskLevel: 'low' | 'medium' | 'high' }` where risk = high if fan-in > 10 and no test coverage.
- CLI: `scip-query change-surface <file>`

**Value:** One command before modifying a file. Shows what's exported, who uses it, what's tested, and what's risky.

### 1.3 `diff-impact`

**Purpose:** Given the current git diff, compute the affected symbol set.

**Implementation:**
- New file: `src/queries/diff-impact.ts`
- Algorithm:
  1. Run `git diff --name-only HEAD` (via `execFileSync`) to get changed files
  2. For each changed file, get all symbols defined in it via `symbols()` logic
  3. For each symbol, get its fan-in count and test coverage
  4. Aggregate: total changed symbols, total consumers affected, test coverage gaps
- Output type: `DiffImpactResult` — `{ changedFiles, changedSymbols[], affectedConsumers[], uncoveredSymbols[], summary }`
- CLI: `scip-query diff-impact [--base <ref>]` (default: diff against HEAD)
- Note: Needs git available. If not in a git repo, error gracefully.

**Value:** "You changed 3 files — here are the 47 symbols affected, the 12 files that consume them, and the 5 gaps in test coverage."

### Phase 1 files to create:
- `src/queries/affected.ts`
- `src/queries/change-surface.ts`
- `src/queries/diff-impact.ts`
- Types added to `src/types.ts`
- Exports added to `src/queries/index.ts`
- CLI commands added to `src/cli.ts`

### Phase 1 files to modify:
- `src/types.ts` — add `AffectedResult`, `ChangeSurfaceResult`, `DiffImpactResult`
- `src/queries/index.ts` — add exports
- `src/cli.ts` — add 3 commands

---

## Phase 2: De-bloating Commands (5 commands)

These serve Use Case 2 — keeping the codebase clean.

### 2.1 `drift [module]`

**Purpose:** Detect pattern drift — files that don't match the typical dependency profile for their directory.

**Implementation:**
- New file: `src/queries/drift.ts`
- Algorithm:
  1. Build file dep profiles per directory (group files by their parent dir)
  2. For each directory with 3+ files, compute the "median" dependency set — deps that appear in >50% of files in that dir
  3. For each file, compute how much it deviates from the median: which expected deps are missing, which unexpected deps are present
  4. Score deviation as a percentage. Report files with highest deviation.
- Reuse: `buildFileDepGraph()` from `query-support.ts` for the dep edges.
- Output type: `DriftResult` — `{ file, directory, deviationPercent, missingExpectedDeps[], unexpectedDeps[] }`
- CLI: `scip-query drift [module] [--min-deviation N]` (default min-deviation: 30%)

**Value:** Finds the files that don't follow the conventions of their neighbors. If 8 of 10 services import a validator and 2 don't, those 2 are flagged.

### 2.2 `wrapper-candidates`

**Purpose:** Find symbols that are only ever called through one intermediary — premature abstractions that add indirection without value.

**Implementation:**
- New file: `src/queries/wrapper-candidates.ts`
- Algorithm:
  1. Find all symbols with fan-in = 1 (exactly one caller)
  2. For each, check if that single caller has fan-in > 3 (is widely used)
  3. If so, the single-caller symbol is a wrapper candidate — it could be inlined into its caller
  4. Also check LOC: small wrappers (< 10 LOC) are the strongest candidates
- SQL: Subquery on `mentions` grouped by `symbol_id`, `HAVING COUNT(DISTINCT document_id) = 1`, then join to find the caller's fan-in.
- Output type: `WrapperCandidate` — `{ symbol, shortName, file, loc, singleCaller, callerFanIn }`
- CLI: `scip-query wrapper-candidates [--scope path] [--max-loc N]`

**Value:** "This function exists only to call another function. You can inline it." Catches over-engineering.

### 2.3 `passthrough-candidates`

**Purpose:** Find functions that just forward to one other function without adding logic.

**Implementation:**
- New file: `src/queries/passthrough-candidates.ts`
- Algorithm:
  1. Find symbols with exactly 1 callee (they only call one external thing)
  2. Filter to small functions (< 15 LOC)
  3. These are likely passthroughs: `getUser(id) { return userRepo.findById(id); }`
- Reuse: `getCalleeRowsForSymbol()` from `query-support.ts` to count callees.
- Output type: `PassthroughCandidate` — `{ symbol, shortName, file, loc, forwardsTo, forwardsToFile }`
- CLI: `scip-query passthrough-candidates [--scope path] [--max-loc N]`

**Value:** Finds functions that are pure indirection. Either inline them or verify they exist for a reason (dependency inversion, testing boundary, etc.)

### 2.4 `stale-abstractions`

**Purpose:** Find interfaces/base classes/generics with exactly 1 implementation or 1 caller.

**Implementation:**
- New file: `src/queries/stale-abstractions.ts`
- Algorithm:
  1. Find type-level symbols (using `#` in the SCIP symbol — indicates class/interface/type)
  2. For each, count cross-file references (fan-in)
  3. Symbols with fan-in = 1 are single-consumer abstractions
  4. Cross-reference with LOC: large single-consumer abstractions are the most wasteful
- SQL: Filter `gs.symbol LIKE '%#%'` (type-level), then count mentions with role=0 from different documents.
- Output type: `StaleAbstraction` — `{ symbol, shortName, file, loc, consumers: number, implementors: number }`
- CLI: `scip-query stale-abstractions [--scope path] [--min-loc N]`

**Value:** An interface with one implementation isn't an abstraction — it's indirection. A generic helper called from one place isn't reusable — it's premature.

### 2.5 `complexity-hotspots`

**Purpose:** Composite complexity score per symbol combining LOC, fan-in, fan-out, and callee count.

**Implementation:**
- New file: `src/queries/complexity-hotspots.ts`
- Algorithm:
  1. For each non-trivial symbol (>= minLoc), compute:
     - LOC (from defn_enclosing_ranges)
     - Fan-in (count of distinct referencing documents)
     - Fan-out (count of distinct referenced symbols in other files)
     - Callee count (total callees within definition range)
  2. Score = `(LOC / 50) * (fanIn / 5) * (fanOut / 5)` (normalized so a 50-LOC function with 5 consumers and 5 callees scores ~1.0)
  3. Sort by score descending
- Reuse: Similar SQL patterns to `bottlenecks.ts` and `fan.ts`.
- Output type: `ComplexityHotspot` — `{ symbol, shortName, file, loc, fanIn, fanOut, calleeCount, score }`
- CLI: `scip-query complexity-hotspots [--scope path] [--min-loc N] [-n limit]`

**Value:** The symbols with the highest scores are the ones most likely to contain bugs, be hardest to modify, and benefit most from decomposition. Combines multiple signals into one prioritized view.

### Phase 2 files to create:
- `src/queries/drift.ts`
- `src/queries/wrapper-candidates.ts`
- `src/queries/passthrough-candidates.ts`
- `src/queries/stale-abstractions.ts`
- `src/queries/complexity-hotspots.ts`

### Phase 2 files to modify:
- `src/types.ts` — add 5 result types
- `src/queries/index.ts` — add 5 exports
- `src/cli.ts` — add 5 commands

---

## Phase 3: Composite Health Report (2 commands)

### 3.1 `health`

**Purpose:** Single command that runs all de-bloat analyses and produces a prioritized action list.

**Implementation:**
- New file: `src/queries/health.ts`
- Algorithm: Run each analysis in sequence, aggregate results:
  1. `dead()` → count dead symbols, total recoverable LOC
  2. `isolated()` → count orphaned symbols
  3. `cycles()` → count circular deps
  4. `similarAll()` → count high-similarity pairs
  5. `extractCandidates()` → count extraction opportunities
  6. `wrapperCandidates()` → count wrapper symbols (new, from Phase 2)
  7. `passthroughCandidates()` → count passthroughs (new, from Phase 2)
  8. `staleAbstractions()` → count single-consumer types (new, from Phase 2)
  9. `drift()` → count drifted files (new, from Phase 2)
  10. `complexityHotspots()` → top 5 most complex symbols (new, from Phase 2)
- Output: Grouped sections with counts and top items. A "health score" (0-100) based on weighted findings. Concrete action items sorted by effort/impact.
- Output type: `HealthReport` — sections for each analysis, overall score, prioritized action list.
- CLI: `scip-query health [--scope path] [--json]` (JSON mode for programmatic consumption by agents)

**Value:** The difference between "powerful tool for experts" and "tool that actually gets used." One command, one report, one action list.

### 3.2 `convergence <symbol1> <symbol2>`

**Purpose:** Given two similar symbols (flagged by `similar`), show what a consolidated version would look like.

**Implementation:**
- New file: `src/queries/convergence.ts`
- Algorithm:
  1. Get callee sets for both symbols (via `getCalleeRowsForSymbol()`)
  2. Compute shared callees (the body of the consolidated function)
  3. Compute unique-to-A and unique-to-B (the parameterization points)
  4. Report: "The consolidated function would call [shared callees]. A's unique behavior ([unique-to-A]) and B's unique behavior ([unique-to-B]) become parameters or strategy arguments."
  5. Also show the file locations and LOC of both symbols for context.
- Output type: `ConvergenceResult` — `{ symbolA, symbolB, sharedCallees[], uniqueToA[], uniqueToB[], consolidationStrategy }`
- CLI: `scip-query convergence <symbol1> <symbol2>`

**Value:** Turns a similarity finding into a concrete refactoring prescription. "These two are 75% similar" becomes "here's what the merged version looks like."

### Phase 3 files to create:
- `src/queries/health.ts`
- `src/queries/convergence.ts`

### Phase 3 files to modify:
- `src/types.ts` — add `HealthReport`, `ConvergenceResult`
- `src/queries/index.ts` — add 2 exports
- `src/cli.ts` — add 2 commands

### Phase 3 depends on: Phase 2 (health report calls Phase 2 commands)

---

## Phase 4: Agent Usage Guide + Use Case Documentation

### 4.1 `docs/AGENT_GUIDE.md`

Comprehensive guide for AI agents (and humans) on how to use scip-query for specific goals. Structured as goal-oriented workflows, not command reference (that's already in README.md).

**Sections:**

#### "I need to understand how a system works before making changes"
1. Start with `system <module>` for the full map
2. Pick the entry point and run `call-graph <symbol>` to see what it calls and who calls it
3. Run `deps <file>` and `rdeps <file>` to map the file-level dependency boundary
4. Run `surface <module>` to understand the true public API (not just what's exported)
5. Run `trace <symbol>` for any specific symbol you need to understand
6. Run `change-surface <file>` for a pre-change briefing on anything you're about to modify
7. Run `diff-impact` after making changes to verify the blast radius

#### "I need to write a concrete implementation plan"
1. Run `system <module>` to understand the target area
2. Run `symbols <file>` on each file you'll modify to get line ranges and signatures
3. Run `surface <module>` to identify the public contract you must preserve
4. Run `refs <symbol>` for any symbol you plan to change, rename, or remove
5. Run `affected <symbol>` for transitive impact on critical symbols
6. Run `fan-in <symbol>` to quantify blast radius for each change
7. Run `test-coverage <symbol>` to identify test gaps before you start

#### "I want to clean up and de-bloat a codebase"
1. Run `health` for the full prioritized report (start here)
2. Address dead code first: `dead --min-loc 10 --skip-barrels` → safe deletions
3. Address isolated symbols: `isolated --min-loc 5` → completely safe deletions
4. Break cycles: `cycles` → structural fixes
5. Reduce duplication: `similar --min-similarity 0.6` → consolidation candidates
6. For each similar pair, run `convergence <a> <b>` to get the refactoring prescription
7. Find extraction opportunities: `extract-candidates --min-loc 20`
8. Remove unnecessary indirection: `wrapper-candidates`, `passthrough-candidates`
9. Prune premature abstractions: `stale-abstractions`
10. Fix pattern drift: `drift` → bring outlier files into line with their neighbors

#### "I want to assess code quality and risk"
1. Run `health` for the overall score
2. Run `complexity-hotspots -n 20` for the riskiest symbols
3. Run `bottlenecks -n 20` for coupling pressure points
4. Run `deep-chains --min-depth 5` for architectural layering issues
5. Run `test-coverage` for the coverage percentage
6. Run `doc-coverage` for documentation gaps

#### "I want to understand the impact of a change I already made"
1. Run `diff-impact` to see what your changes affect
2. Run `affected <symbol>` for any symbol you modified
3. Run `test-coverage <symbol>` for each affected symbol to find test gaps

#### Command cheat sheet
Quick reference table: "If you want to know X, run Y."

### 4.2 Update `README.md`

- Add link to AGENT_GUIDE.md in the README
- Add a "Workflows" section that links to the guide
- Update command count and command table with new Phase 1-3 commands

### Phase 4 files to create:
- `docs/AGENT_GUIDE.md`

### Phase 4 files to modify:
- `README.md` — add workflows section, update command count

---

## Execution Order

```
Phase 1 (impact + planning)     → 3 new commands, ~400 LOC
Phase 2 (de-bloating)           → 5 new commands, ~500 LOC
Phase 3 (health + convergence)  → 2 new commands, ~300 LOC
Phase 4 (documentation)         → 1 new doc, README update

Total: 10 new commands, ~1200 LOC of query logic, 1 agent guide
```

Each phase is independently testable and committable. Phase 3 depends on Phase 2. Phase 4 depends on Phases 1-3 (references all commands). Phases 1 and 2 are independent and can be built in parallel.

### Shared infrastructure all phases will use:
- `query-support.ts` — `buildFileDepGraph()`, `findFirstSymbolMatch()`, `getCalleeRowsForSymbol()`
- `db.ts` — `pathExclusionsFor()`, `symbolNoiseFor()`, `symbolNoise`, `localSymbolPredicate`
- `clean-signature.ts` — for any command that displays signatures
- `symbol-parser.ts` — `shortenSymbol()` for all display output

No new shared infrastructure needed. The existing helpers cover all planned commands.
