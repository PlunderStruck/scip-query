---
name: scip-debloat
description: Comprehensive codebase de-bloating using scip-query. Finds dead code, duplication, unnecessary abstractions, consolidation opportunities, pattern drift, and structural bloat from every possible angle. Produces a prioritized action list.
allowed-tools: [Bash, Write, Edit, Glob, Agent, TaskCreate, TaskUpdate, TaskGet, TaskList]
keywords: [debloat, clean, cleanup, refactor, dead-code, duplication, dry, consolidate, simplify, reduce, bloat, unused, stale, drift, health]
---

# Codebase De-Bloating with scip-query

You are performing a comprehensive codebase audit to find every opportunity to reduce bloat, eliminate duplication, consolidate similar code, remove unnecessary abstractions, and improve structural health. You are thorough — you check from every angle, not just the obvious ones. Every finding must come from `scip-query`.

---

## When to Use This Skill

- "Clean up this codebase"
- "Find dead code"
- "What can we delete?"
- "Find duplication"
- "Make this codebase smaller"
- "Are there things we can consolidate?"
- "Run a health check"
- "De-bloat this module"

---

## Hard Rules

1. **Run `scip-query health` first.** It aggregates all analyses and gives you the prioritized starting point. Don't skip it.

2. **Check from every angle.** Dead code is the easy win. Go deeper — similar functions, stale abstractions, wrapper indirection, pattern drift, convergence opportunities, passthrough functions. Each catches a different class of bloat.

3. **Verify before recommending deletion.** Before saying "delete X," confirm it's truly unused: check `scip-query refs`, `scip-query affected`, and whether it's an entry point (CLI, worker, test file). Entry points appear dead because nothing imports them.

4. **Produce concrete actions.** Don't say "there's some duplication." Say "functions A and B have 80% callee overlap — consolidate into a shared helper with the 2 divergent callees as parameters (per `scip-query convergence A B`)."

5. **The report goes in `reports/debloat/YYYY-MM-DD-<scope>.md`.** If no reports directory exists, use the project root.

---

## Symbol Lookup Tips

scip-query accepts partial symbol names — you don't need the full SCIP symbol path. These all work:

```bash
scip-query code processVegaMention              # just the function name
scip-query call-graph ChatService               # just the class name
scip-query trace getActiveInferenceConfig       # any unique substring
```

**Avoid parentheses** — `()` causes shell parse errors in zsh/bash:
```bash
# BAD — shell tries to execute a subshell
scip-query code processVegaMention()

# GOOD — no parens needed, scip-query strips them internally
scip-query code processVegaMention

# ALSO GOOD — single quotes protect special characters
scip-query code 'processVegaMention'
```

**Read source by file + line range** when the symbol name is ambiguous:
```bash
scip-query code 'src/modules/chat/chat.service.ts:100-200'
```

**If "Symbol not found":**
1. Try a shorter/simpler name — `login` instead of `AuthService:login`
2. Try `scip-query symbols <file>` to see what symbols exist in the file
3. Try `scip-query trace <name>` which uses a different lookup path
4. Use the `file:line-line` syntax for `code` if you know the location

---

## The 10 Angles of Bloat

Run every one of these. Each catches a different class of problem. Skip none.

### Angle 1: Dead Code (zero references)

```bash
scip-query dead --min-loc 5 --skip-barrels
```

Symbols with zero cross-file references. The `--skip-barrels` flag excludes references through barrel re-exports (index.ts) which can hide truly dead code.

**What to look for:**
- "dead code" = not referenced anywhere, not even in same file → safe to delete
- "dead export" = used locally but never imported → make private or delete the export
- Ignore entry points: `cli.ts`, worker files, `index.ts` barrels appear dead because they're consumed by the runtime, not by other source files

**Action:** Delete dead code. Remove `export` from dead exports.

### Angle 2: Isolated Symbols (completely disconnected)

```bash
scip-query isolated --min-loc 3
```

Stricter than dead code — these symbols reference nothing AND are referenced by nothing. Completely disconnected from the codebase graph.

**Action:** Delete. These are the safest deletions possible.

### Angle 3: Similar Functions (callee overlap)

```bash
scip-query similar --min-similarity 0.5 --min-callees 3
```

Functions that call the same set of symbols. High Jaccard similarity = doing the same work.

For each high-similarity pair, get the consolidation prescription:

```bash
scip-query convergence <symbolA> <symbolB>
```

This shows: shared callees (common body), unique callees (parameterization points), and a recommended strategy.

**What to look for:**
- Pairs above 70% = strong consolidation candidates
- Pairs above 50% = worth investigating, may share a common helper
- Same file = less interesting. Cross-file = more valuable to consolidate.

**Action:** Extract shared logic into a common helper. Pass divergent callees as parameters or strategy callbacks.

### Angle 4: Similar Files (dependency profile overlap)

```bash
scip-query similar-files --min-similarity 0.6 --min-deps 3
```

Files that import the same set of modules. These are structurally doing the same job.

**What to look for:**
- 90%+ similarity with different unique deps = copy-paste variants
- 100% similarity = likely redundant modules that should be merged or share a base

**Action:** Merge or extract a shared base module.

### Angle 5: Similar Chains (parallel end-to-end flows)

```bash
scip-query similar-chains --min-similarity 0.5
```

End-to-end dependency flows that are structurally similar but diverge at a few points. These represent "two parallel mechanisms doing the same thing."

**What to look for:**
- Chains with 1-2 divergence points = strongest consolidation signal
- Common prefix = shared entry path
- Common suffix = shared exit path
- Divergence points = where to extract a shared abstraction

**Action:** Extract the common chain into a shared pipeline. The divergence points become pluggable strategies.

### Angle 6: Extraction Candidates (large functions with callee clusters)

```bash
scip-query extract-candidates --min-loc 15 --min-callees 5
```

Large functions where the callees form distinct, isolated clusters. Each cluster is a natural "Extract Method" seam.

**What to look for:**
- Clusters with high isolation (>80%) = clean extraction
- Multiple clusters in one function = the function is doing too many things

**Action:** Extract each isolated cluster into its own function.

### Angle 7: Wrapper Functions (single-consumer indirection)

```bash
scip-query wrapper-candidates --max-loc 15
```

Small functions called by exactly one consumer. If the consumer is widely used but the wrapper has only one caller, the wrapper may be unnecessary indirection.

**What to look for:**
- LOC < 10 + single caller = strong inline candidate
- The caller's fan-in tells you how "public" the wrapper's consumer is

**Action:** Inline the wrapper into its single consumer, unless it serves a testing/dependency-inversion purpose.

### Angle 8: Passthrough Functions (pure forwarding)

```bash
scip-query passthrough-candidates --max-loc 15
```

Functions with exactly one callee and small LOC. They just forward to another function without adding logic.

**Action:** Inline or verify they exist for a structural reason (DI, testing boundary).

### Angle 9: Stale Abstractions (over-engineering)

```bash
scip-query stale-abstractions --min-loc 3
```

Types, interfaces, and classes with 0-1 cross-file consumers. An interface with one implementation isn't an abstraction — it's indirection. A type used by one file isn't reusable — it's premature.

**What to look for:**
- 0 consumers = completely unused type → delete
- 1 consumer = single-use abstraction → inline into the consumer or merge

**Action:** Delete unused types. Inline single-consumer types.

### Angle 10: Pattern Drift (convention violations)

```bash
scip-query drift
```

Files that deviate from their directory's typical dependency pattern. If 8 of 10 services import a validator and 2 don't, those 2 are flagged.

**What to look for:**
- Missing expected deps = the file isn't following conventions (may be missing validation, logging, etc.)
- Unexpected deps = the file depends on things its siblings don't (may be reaching into the wrong layer)
- Barrel files (index.ts) and orchestrators naturally deviate — ignore those

**Action:** Bring drifted files into line with their neighbors, or document why the deviation is intentional.

### Angle 11: Redundant Re-exports (dead barrel entries)

```bash
scip-query redundant-reexports
```

Barrel files (index.ts) that re-export symbols nobody actually imports through the barrel. If every consumer imports directly from the source file, the re-export is dead weight.

**What to look for:**
- Symbols with 0 barrel consumers = completely redundant re-export
- Symbols where barrel consumers < direct consumers = barrel mostly bypassed

**Action:** Remove unused re-exports from barrel files to reduce indirection.

### Angle 12: Similar Signatures (same-shape functions)

```bash
scip-query similar-signatures --min-loc 5
```

Functions with the same parameter types and return type but different names. "Same shape" is a different signal from "same callees" — catches cases where two functions accept and return the same things even if they do different work internally.

**What to look for:**
- Groups of 3+ functions with identical signatures = strong consolidation signal
- Groups of 2 with identical signatures + similar callees = very strong signal
- Cross-reference with `scip-query convergence` for the consolidation prescription

**Action:** Investigate whether same-shape functions can share an implementation or a common interface.

---

## Structural Assessment (run alongside the 12 angles)

These provide context for the cleanup, not direct actions:

```bash
scip-query cycles                          # Circular dependencies (must fix)
scip-query deep-chains --min-depth 5       # Excessively deep dependency chains
scip-query bottlenecks -n 10               # Coupling pressure points
scip-query complexity-hotspots -n 10       # Riskiest symbols
scip-query hotspots -n 10                  # Most-referenced symbols
scip-query doc-coverage --min-loc 5        # Documentation coverage
```

---

## Workflow

### Phase 1: Health Check (5 minutes)

```bash
scip-query reindex                         # Ensure index is fresh
scip-query health                          # Get the full report
```

Read the health score, the findings breakdown, and the prioritized action list. This is your roadmap.

### Phase 2: Deep Scan (10-15 minutes)

Run all 10 angles plus the structural assessment. For each:
1. Run the command
2. Record the count and top findings
3. For actionable findings, drill deeper (e.g., `convergence` for similar pairs)

Use parallel subagents for speed — each angle is independent.

### Phase 3: Synthesize (5 minutes)

Produce the de-bloat report. Group findings by priority:

1. **Safe deletions** (dead code, isolated symbols) — zero risk, immediate LOC reduction
2. **Structural fixes** (cycles, stale abstractions) — fix architecture issues
3. **Consolidation** (similar functions, similar files, similar chains) — reduce duplication
4. **Extraction** (extract candidates, large functions) — reduce complexity
5. **Indirection removal** (wrappers, passthroughs) — simplify call chains
6. **Convention alignment** (drift) — improve consistency

### Phase 4: Estimate Impact

For each group, calculate:
- Number of symbols affected
- Lines of code recoverable
- Risk level (low/medium/high)
- Effort level (low/medium/high)

---

## Output Format

The report is a markdown file with:

```markdown
# De-Bloat Report: [project/module]
**Date:** YYYY-MM-DD
**Health Score:** N/100
**Scope:** [files analyzed]

## Summary
- Total findings: N
- Estimated recoverable LOC: N
- Safe deletions: N symbols
- Consolidation candidates: N pairs
- Structural issues: N

## Priority 1: Safe Deletions
[List of dead code and isolated symbols with file:line references]

## Priority 2: Structural Fixes
[Cycles, stale abstractions with fix recommendations]

## Priority 3: Consolidation Opportunities
[Similar pairs with convergence prescriptions]

## Priority 4: Extraction Opportunities
[Large functions with cluster analysis]

## Priority 5: Indirection Removal
[Wrappers and passthroughs with inline recommendations]

## Priority 6: Convention Alignment
[Drifted files with expected vs actual deps]

## Structural Metrics
- Circular dependencies: N
- Max dependency chain depth: N
- Coupling bottlenecks: [top 5]
- Complexity hotspots: [top 5]
- Doc coverage: N%
```

Every finding includes the scip-query command that produced it.

---

## Subagent Briefing Template

When using parallel subagents to scan different angles simultaneously:

```
## Task: Run de-bloat angle [N]

You are scanning a codebase for cleanup opportunities using scip-query.

Run the following command and analyze the results:
[specific scip-query command]

For each finding:
1. Record the symbol, file, line range, and LOC
2. Verify it's a true positive (not an entry point, not a test helper)
3. Classify: safe deletion / consolidation candidate / extraction candidate / indirection
4. Estimate effort: low (delete/inline) / medium (extract/refactor) / high (restructure)

Report format: one finding per line with file:line, symbol name, classification, and the scip-query command that found it.

Do NOT use grep, rg, or Read. Use only scip-query commands.
```

---

## scip-query Quick Reference

| Angle | Command |
|---|---|
| Full health report | `scip-query health` |
| Dead code | `scip-query dead --min-loc 5 --skip-barrels` |
| Isolated symbols | `scip-query isolated --min-loc 3` |
| Similar functions | `scip-query similar --min-similarity 0.5` |
| Consolidation prescription | `scip-query convergence <a> <b>` |
| Similar files | `scip-query similar-files --min-similarity 0.6` |
| Similar chains | `scip-query similar-chains --min-similarity 0.5` |
| Extraction candidates | `scip-query extract-candidates --min-loc 15` |
| Wrappers | `scip-query wrapper-candidates --max-loc 15` |
| Passthroughs | `scip-query passthrough-candidates` |
| Stale abstractions | `scip-query stale-abstractions --min-loc 3` |
| Pattern drift | `scip-query drift` |
| Circular dependencies | `scip-query cycles` |
| Dependency depth | `scip-query deep-chains --min-depth 5` |
| Coupling pressure | `scip-query bottlenecks -n 10` |
| Complexity hotspots | `scip-query complexity-hotspots -n 10` |
| Most-referenced | `scip-query hotspots -n 10` |
| Doc coverage | `scip-query doc-coverage` |
| Redundant re-exports | `scip-query redundant-reexports` |
| Similar signatures | `scip-query similar-signatures --min-loc 5` |
| Read source | `scip-query code <symbol>` |
| Verify references | `scip-query refs <symbol>` |
| Check blast radius | `scip-query affected <symbol>` |
