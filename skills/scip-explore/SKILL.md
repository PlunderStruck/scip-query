---
name: scip-explore
description: Deep codebase exploration using scip-query. Trace how any system works end-to-end — call graphs, data flow, dependencies, blast radius — using compiler-resolved analysis. Use when you need to understand how something works before answering questions or making changes.
allowed-tools: [Bash, Write, Edit, Glob, Agent, TaskCreate, TaskUpdate, TaskGet, TaskList]
keywords: [explore, understand, trace, investigate, how-does, explain, architecture, flow, debug, navigate, codebase]
---

# Codebase Exploration with scip-query

You are exploring a codebase to build a deep, accurate understanding of how a system works. Every claim must come from `scip-query` — not from memory, not from grep, not from file reads. You are producing verified knowledge about how code actually behaves, not guesses about how it might behave.

---

## When to Use This Skill

- "How does X work?"
- "What happens when a user does Y?"
- "Walk me through the flow from A to B"
- "What depends on this module?"
- "Is it safe to change this?"
- "Help me understand this codebase"

---

## Hard Rules

1. **Every claim must come from scip-query.** If you say "function X calls function Y," you must have run `scip-query call-graph X` or `scip-query code X` to verify it. No memory. No assumptions.

2. **Read the code.** Don't describe what a function "probably does" — run `scip-query code <symbol>` and describe what it actually does.

3. **Follow the graph, not the folder structure.** File organization can be misleading. Use `scip-query deps`, `scip-query rdeps`, `scip-query call-graph`, and `scip-query dataflow` to trace actual execution paths.

4. **Start wide, then narrow.** Begin with `scip-query system` for the module map, then drill into specific symbols with `scip-query call-graph`, `scip-query code`, and `scip-query dataflow`.

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

## Exploration Workflow

### Step 1: Orient — What are we looking at?

Start with the high-level map. Run these first:

```bash
scip-query stats                      # How big is this codebase?
scip-query system <module>            # Full module map: files, symbols, deps
scip-query symbols <entry-file>       # What's in the entry point?
```

**Output:** List all files in the module, the key symbols, what it depends on, and what depends on it. This is your map.

### Step 2: Trace the entry point

Find where execution starts and follow it:

```bash
scip-query call-graph <entry-symbol>  # What does it call? Who calls it?
scip-query code <entry-symbol>        # Read the actual source
scip-query dataflow <entry-symbol>    # What data flows through it?
```

For each callee, repeat: read the code, check the call graph, trace the dataflow. Build a chain from entry to leaf.

### Step 3: Map the dependencies

Understand what the system depends on and who depends on it:

```bash
scip-query deps <file>                # Forward: what does this file need?
scip-query rdeps <file>               # Reverse: who breaks if this changes?
scip-query surface <module>           # True public API (what consumers use)
scip-query affected <symbol>          # Full transitive blast radius
```

### Step 4: Understand data flow

For each key symbol, trace how data moves through the system:

```bash
scip-query dataflow <symbol>          # Definition sites, usage sites, producers, consumers
scip-query slice <symbol>             # Backward: what feeds into this?
scip-query slice <symbol> --forward   # Forward: what does this feed into?
```

### Step 5: Assess complexity and risk

Identify the riskiest parts of the system:

```bash
scip-query complexity <symbol>        # Per-symbol: branches, cyclomatic, fan-in/out
scip-query complexity-hotspots        # Top N most complex symbols
scip-query bottlenecks                # Coupling pressure points
scip-query change-surface <file>      # Per-file risk: external consumers, blast radius
```

### Step 6: Check structural health

Look for red flags:

```bash
scip-query cycles                     # Circular dependencies
scip-query deep-chains --min-depth 5  # How deep do dependency chains go?
scip-query coupling <file1> <file2>   # How tightly coupled are two files?
```

---

## Answering Specific Questions

### "How does function X work?"

```bash
scip-query code X                     # Read the source
scip-query call-graph X               # What it calls, who calls it
scip-query dataflow X                 # What data flows through it
scip-query complexity X               # How complex is it
```

### "What happens when a user does Y?"

1. Find the entry point: `scip-query files <handler-pattern>` or `scip-query symbols <route-file>`
2. Read the handler: `scip-query code <handler>`
3. Follow each call: `scip-query call-graph <callee>` → `scip-query code <callee>` → repeat
4. Trace the data: `scip-query dataflow <key-variable>` at each step
5. Map the end state: What gets written to DB? What gets sent to the client?

### "Is it safe to change X?"

```bash
scip-query change-surface <file>      # Risk per symbol: consumers, blast radius
scip-query affected X --max-depth 3   # Full transitive blast radius
scip-query similar X                  # Is there duplicated logic to consolidate?
```

### "What's the architecture of module X?"

```bash
scip-query system X                   # Files, symbols, deps in/out
scip-query deep-chains --scope X      # Dependency depth within the module
scip-query bottlenecks --scope X      # Coupling hotspots
scip-query cycles --scope X           # Any circular deps?
scip-query hotspots --scope X         # Most-referenced symbols
```

### "How are these two things related?"

```bash
scip-query coupling <file1> <file2>   # Shared symbols between files
scip-query convergence <sym1> <sym2>  # How similar are two functions?
scip-query similar-chains             # Do they share dependency paths?
```

---

## Output Format

When reporting exploration results, structure them as:

1. **Overview** — What the system is and what it does (1-3 sentences)
2. **Entry points** — Where execution begins (files + symbols + line numbers)
3. **Call flow** — Step-by-step trace from entry to leaf, with source citations
4. **Data flow** — What data enters, how it transforms, where it ends up
5. **Dependencies** — What the system depends on (with `deps` citations)
6. **Consumers** — What depends on this system (with `rdeps`/`surface` citations)
7. **Risk areas** — Complex symbols, high fan-in, high-consumer surfaces, or broad blast radius (with `complexity`/`change-surface` citations)

Every file path, line number, and behavioral claim includes the scip-query command that verified it.

---

## scip-query Quick Reference

| Purpose | Command |
|---|---|
| Read source code | `scip-query code <symbol> [-C N]` |
| All symbols in a file | `scip-query symbols <file>` |
| Find files | `scip-query files <pattern>` |
| Full module map | `scip-query system <module>` |
| True public API | `scip-query surface <module>` |
| Callers + callees | `scip-query call-graph <symbol>` |
| Every reference | `scip-query refs <symbol>` |
| Definition + references | `scip-query trace <symbol>` |
| Forward dependencies | `scip-query deps <file>` |
| Reverse dependencies | `scip-query rdeps <file>` |
| Transitive blast radius | `scip-query affected <symbol>` |
| Pre-change risk briefing | `scip-query change-surface <file>` |
| Dataflow analysis | `scip-query dataflow <symbol>` |
| Backward slice | `scip-query slice <symbol>` |
| Forward slice | `scip-query slice <symbol> --forward` |
| Complexity per symbol | `scip-query complexity <symbol>` |
| Top complexity | `scip-query complexity-hotspots` |
| Coupling pressure | `scip-query bottlenecks` |
| Coupling between files | `scip-query coupling <file1> <file2>` |
| Circular dependencies | `scip-query cycles` |
| Dependency depth | `scip-query deep-chains` |
| Similar functions | `scip-query similar <symbol>` |
| Same-shape functions | `scip-query similar-signatures` |

Full documentation: Run `scip-query --help` or read the README at the scip-query repo.
