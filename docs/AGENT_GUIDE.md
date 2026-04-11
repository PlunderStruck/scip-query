# scip-query Agent Guide

Goal-oriented workflows for AI agents and developers. Each section starts with a goal and walks through the exact commands to run, what to expect back, and how to use the results.

For command syntax and options reference, see [README.md](../README.md).

---

## Workflow 1: Understand a system before making changes

**Goal:** Build a complete mental model of a module or feature area so you can write a precise implementation plan with no ambiguity about what code exists, what it does, and what depends on it.

### Steps

1. **Map the module**
   ```bash
   scip-query system <module-path>
   ```
   Returns: all files in the module, all exported symbols with line ranges, all inbound and outbound dependencies. This is your starting map.

2. **Understand the public contract**
   ```bash
   scip-query surface <module-path>
   ```
   Returns: which symbols external consumers actually reference. This is the true public API — not what's exported, but what's used. Any change to these symbols is a breaking change.

3. **Trace specific symbols**
   ```bash
   scip-query trace <symbol-name>
   ```
   Returns: where the symbol is defined (file + line range + signature) and every file that references it. Use this for any symbol you need to understand deeply.

4. **Map the call graph**
   ```bash
   scip-query call-graph <function-name>
   ```
   Returns: what calls this function (incoming) and what this function calls (outgoing). Gives you the function's role in the execution flow.

5. **Check blast radius**
   ```bash
   scip-query affected <symbol-name>
   ```
   Returns: the full transitive closure of symbols that could break if this symbol changes. Depth 1 = direct consumers. Depth 2 = consumers of consumers. Shows the complete ripple effect.

6. **Pre-change briefing**
   ```bash
   scip-query change-surface <file>
   ```
   Returns: every symbol in the file, how many external consumers each has, and a risk level (high/medium/low). Run this before modifying any file.

### What you should know after this workflow

- Every file in the module and what it contains
- The true public API (what consumers actually use)
- The full dependency graph (what the module depends on and what depends on it)
- The blast radius of any specific symbol change
- Which symbols are high-risk (many consumers, wide blast radius)

---

## Workflow 2: Write a concrete implementation plan

**Goal:** Produce an implementation plan where every file to create/modify is named, every symbol to change is identified with line numbers, every dependency is mapped, and every risk is called out.

### Steps

1. **Map the target area**
   ```bash
   scip-query system <module-path>
   scip-query symbols <each-file-you-will-modify>
   ```
   Get the full symbol inventory with line ranges and signatures for every file in scope.

2. **Identify the public contract you must preserve**
   ```bash
   scip-query surface <module-path>
   ```
   Any symbol that appears here must maintain backward compatibility or all consumers must be updated.

3. **Map every symbol you plan to change**
   ```bash
   scip-query refs <symbol>        # who uses it
   scip-query affected <symbol>    # transitive blast radius
   scip-query fan-in <symbol>      # quantified consumer count
   ```
   For each symbol you'll modify: know exactly who consumes it and how many layers deep the impact goes.

4. **Check blast radius before editing**
   ```bash
   scip-query change-surface <file>
   scip-query diff-impact
   ```
   Identify which symbols in your change set have many external consumers and which downstream files will be affected.

5. **Find reusable code**
   ```bash
   scip-query similar <symbol-you-plan-to-write>
   scip-query deps <file>
   ```
   Before writing new code, check if something similar already exists. `similar` finds functions with overlapping callee patterns. `deps` shows what the file already imports that you can reuse.

6. **After making changes, verify impact**
   ```bash
   scip-query diff-impact
   scip-query drift
   ```
   Shows every symbol affected by your git diff, every consumer file impacted, and whether the change introduced new structural drift.

### Plan template

```
## Change: [description]

### Files to modify
- `path/to/file.ts` — [what changes, which symbols]
  - `symbolName` (lines X-Y) — [change description]
  - Fan-in: N, External consumers: N, Risk: low/medium/high

### Files to create
- `path/to/new-file.ts` — [purpose]
  - Similar to: `existing-file.ts` (N% callee overlap via `similar`)

### Public contract impact
- `surface` shows N symbols consumed externally
- [List any breaking changes]

### Blast radius
- `affected` shows N symbols across M files at depth 1-2
- [List high-risk symbols]

### Impact checks
- `change-surface` shows N externally consumed symbols
- `diff-impact` shows N downstream consumer files
```

---

## Workflow 3: Clean up and de-bloat a codebase

**Goal:** Systematically reduce unnecessary code, eliminate duplication, and improve structural health.

### Steps

1. **Get the full health report**
   ```bash
   scip-query health
   ```
   This runs every analysis and produces a prioritized action list. Start here. The actions are sorted by impact/effort ratio — do the top ones first.

2. **Delete dead code (safest, highest impact)**
   ```bash
   scip-query dead --min-loc 10 --skip-barrels
   ```
   These symbols have zero cross-file references. They can be safely deleted. `--skip-barrels` ignores references from inactive barrel files, which helps surface exports kept alive only by unused re-export layers without hiding live package entry surfaces.

3. **Delete isolated symbols**
   ```bash
   scip-query isolated --min-loc 5
   ```
   Stricter than `dead` — these symbols have zero references anywhere, including in their own file. Completely disconnected from the codebase.

4. **Break circular dependencies**
   ```bash
   scip-query cycles
   ```
   If any exist, they need structural fixes: dependency inversion, module splitting, or interface extraction.

5. **Consolidate similar functions**
   ```bash
   scip-query similar --min-similarity 0.5
   ```
   Pairs of functions with overlapping callee sets. For each pair:
   ```bash
   scip-query convergence <symbol1> <symbol2>
   ```
   Shows what the consolidated version would look like: shared callees = common body, unique callees = parameterization points.

6. **Extract large functions**
   ```bash
   scip-query extract-candidates --min-loc 20
   ```
   Functions with isolated callee clusters — natural "Extract Method" seams.

7. **Remove unnecessary indirection**
   ```bash
   scip-query wrapper-candidates
   scip-query passthrough-candidates
   ```
   Wrappers: single-consumer symbols that can be inlined. Passthroughs: functions that just forward to one callee.

8. **Prune premature abstractions**
   ```bash
   scip-query stale-abstractions
   ```
   Types and interfaces with 0-1 consumers. An interface with one implementation isn't an abstraction.

9. **Fix pattern drift**
   ```bash
   scip-query drift
   ```

10. **Remove redundant re-exports**
    ```bash
    scip-query redundant-reexports
    ```
    Barrel file entries that nobody imports through. Clean up the barrel.

11. **Find same-shape functions**
    ```bash
    scip-query similar-signatures --min-loc 5
    ```
    Functions with identical parameter/return types. Different signal from callee similarity — catches "same interface, different implementation."
   Files that deviate from their directory's typical dependency pattern. Bring them into line with their neighbors.

### Priority order

| Priority | What | Why |
|---|---|---|
| 1 | Dead code | Zero risk, immediate LOC reduction |
| 2 | Isolated symbols | Zero risk, zero consumers |
| 3 | Circular deps | Structural fix, prevents future problems |
| 4 | Similar functions | Reduces duplication, use `convergence` for prescription |
| 5 | Extraction candidates | Reduces function complexity |
| 6 | Wrappers / passthroughs | Removes unnecessary indirection |
| 7 | Stale abstractions | Removes premature over-engineering |
| 8 | Pattern drift | Consistency improvement |

---

## Workflow 4: Assess code quality and risk

**Goal:** Produce a quality assessment of a codebase or module with quantified metrics.

### Steps

1. **Overall health**
   ```bash
   scip-query health
   scip-query health --json    # for programmatic use
   ```

2. **Complexity risks**
   ```bash
   scip-query complexity-hotspots -n 20
   ```
   Symbols with the highest composite score (LOC x fan-in x fan-out). These are the most likely to contain bugs and the hardest to modify.

3. **Coupling risks**
   ```bash
   scip-query bottlenecks -n 20
   ```
   Symbols with both high fan-in (many consumers) AND high fan-out (many dependencies). Changes to these are risky in both directions.

4. **Architecture depth**
   ```bash
   scip-query deep-chains --min-depth 5
   ```
   Long transitive dependency chains. If chains are deeper than 6-7, the architecture may need flattening.

5. **Structural drift**
   ```bash
   scip-query drift
   ```
   Files with unused imports, layer violations, or dependency profiles that deviate from their neighbors.

### Quality report template

```
## Quality Assessment: [project/module]

### Overview
- Files: N | Symbols: N | Index size: N
- Health score: N/100

### Risk Areas
- Complexity hotspots: [top 5 from complexity-hotspots]
- Coupling bottlenecks: [top 5 from bottlenecks]
- Deepest dependency chain: N layers
- Circular dependencies: N

### Structural quality
- Pattern drift: N files

### Cleanup Opportunities
- Dead code: N symbols (N LOC recoverable)
- Similar function pairs: N
- Stale abstractions: N
```

---

## Workflow 5: Understand impact after making changes

**Goal:** After modifying code, verify what was affected and identify gaps.

### Steps

1. **Compute diff impact**
   ```bash
   scip-query diff-impact
   ```
   Shows: changed files, changed symbols with fan-in counts, and affected consumer files.

2. **Check transitive impact for critical symbols**
   ```bash
   scip-query affected <changed-symbol>
   ```
   For any high fan-in symbol that changed, check the full transitive blast wave.

3. **Re-check structural drift around the changed area**
   ```bash
   scip-query drift
   scip-query change-surface <changed-file>
   ```
   Verify the change did not introduce new dependency-pattern outliers and understand the remaining blast radius.

---

## Quick Reference

| I want to... | Run |
|---|---|
| Understand a module | `system <module>` |
| See what consumers actually use | `surface <module>` |
| Find all references to a symbol | `refs <symbol>` or `trace <symbol>` |
| See what a function calls and who calls it | `call-graph <symbol>` |
| Check blast radius of a change | `affected <symbol>` |
| Get a pre-change briefing | `change-surface <file>` |
| See impact of my git changes | `diff-impact` |
| Find dead code to delete | `dead --min-loc 10 --skip-barrels` |
| Find duplicate functions | `similar --min-similarity 0.5` |
| Find same-shape functions | `similar-signatures --min-loc 5` |
| Get a refactoring prescription | `convergence <sym1> <sym2>` |
| Find redundant barrel re-exports | `redundant-reexports` |
| Find extraction opportunities | `extract-candidates --min-loc 20` |
| Find unnecessary wrappers | `wrapper-candidates` |
| Find single-implementation types | `stale-abstractions` |
| Find pattern outliers | `drift` |
| Get overall codebase health | `health` |
| Find riskiest symbols | `complexity-hotspots` |
| Find coupling pressure points | `bottlenecks` |
| Find circular dependencies | `cycles` |
---

## Tips for AI Agents

- **Always reindex before analysis** if the codebase has changed significantly: `scip-query reindex`
- **Use `--json` on `health`** for programmatic consumption — parse the JSON to make decisions
- **Run `change-surface` before every file modification** — it takes <1 second and prevents surprises
- **Run `diff-impact` before committing** — catches unexpected blast radius across downstream consumers
- **Use `convergence` after `similar`** — `similar` finds the problem, `convergence` gives the solution
- **Start cleanup with `health`** — it prioritizes for you so you don't have to decide what to fix first
- **Scope commands with `-s`** — most commands accept `--scope <path>` to limit analysis to a specific module. Use this on large codebases to keep results focused.
