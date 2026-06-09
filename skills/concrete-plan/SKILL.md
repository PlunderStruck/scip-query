---
name: concrete-plan
description: Build concrete, checklist-driven implementation plans using scip-query for every code reference. Plans are stress-tested against 11 engineering principles before shipping.
allowed-tools: [Bash, Write, Edit, Glob, Agent, TaskCreate, TaskUpdate, TaskGet, TaskList]
keywords: [plan, design, architecture, implementation, checklist, blueprint, proposal, rfc, spec]
---

# Concrete Implementation Planning

You are writing a production implementation plan as a markdown checklist. Every step must be concrete — exact file paths, line numbers, what the code does today, what it should do after the change. No hand-waving. No "consider doing X." Every claim about existing code must be verified against the actual codebase using `scip-query`.

---

## Hard Rules

1. **Every code reference must come from scip-query.** Run `scip-query reindex` before starting. Re-run if significant code has changed during the session. No reference from memory, grep, or file reads.

2. **Every step must cite its source.** Each step in the plan includes a `Source` field naming the scip-query command that produced the file path, line number, and behavioral claim. A step without a Source is unverified and must not appear in the plan.

3. **Every step must be actionable.** Never write "update this file." Write "In `foo.service.ts:142-158`, the `catch` block swallows `AbortError` — re-throw it instead of logging." Exact lines, current behavior, target behavior.

4. **The plan goes in `docs/plans/YYYY-MM-DD-<short-name>.md`.** Use today's date. The file is a living document — update it as stress-testing reveals new steps.

---

## Symbol Lookup Tips

`scip-query` accepts partial symbol names — you don't need the full SCIP symbol path. These all work:

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
2. Try `scip-query outline <file>` to see what symbols exist in the file
3. Try `scip-query trace <name>` which uses a different lookup path
4. Use the `file:line-line` syntax for `code` if you know the location

---

## Forbidden Tools and Patterns

This skill deliberately excludes `Grep` and `Read` from its allowed tools. This is intentional.

**DO NOT work around this by:**
- Running `grep`, `rg`, or `cat` through Bash. If you catch yourself typing `grep` or `rg`, stop — you are doing it wrong.
- Using `Read` via a subagent to browse files for discovery. Subagents must also use scip-query.
- Spawning Explore agents that fall back to grep and file reads. If a subagent's output does not cite scip-query commands, reject its findings and re-run.

**Instead, use scip-query (full reference at `/Users/aydansalois/Documents/GitHub/scip-query/docs/COMMAND_REFERENCE.md`):**

| You want to... | Use this |
|---|---|
| **Read source code** | `scip-query code <symbol>` (reads file, bounded to definition range) |
| **Read source with context** | `scip-query code <symbol> -C 5` (5 extra lines above/below) |
| Find a symbol / list file contents | `scip-query outline <file>` (all symbols with line ranges + signatures) |
| Find files by name | `scip-query files <pattern>` |
| See callers + callees | `scip-query call-graph <symbol>` |
| Full module map | `scip-query system <module>` |
| True public API | `scip-query surface <module>` |
| Every file referencing a symbol | `scip-query refs <symbol>` |
| Definition + all references | `scip-query trace <symbol>` |
| Forward dependencies | `scip-query deps <file>` |
| Reverse dependencies | `scip-query rdeps <file>` |
| **Full transitive blast radius** | `scip-query affected <symbol>` |
| **Pre-change risk briefing** | `scip-query change-surface <file>` |
| **Git diff impact analysis** | `scip-query diff-impact` |
| **Complexity analysis** | `scip-query complexity <symbol>` (branches, cyclomatic, fan-in/out) |
| **Dataflow: what feeds in/out** | `scip-query dataflow <symbol>` (producers, consumers, usage sites) |
| **Backward slice (what affects this)** | `scip-query slice <symbol>` |
| **Forward slice (what this affects)** | `scip-query slice <symbol> --forward` |
| Find similar functions | `scip-query similar <symbol>` |
| Find same-shape functions | `scip-query similar-signatures` |
| Refactoring prescription | `scip-query convergence <a> <b>` |
| Find redundant re-exports | `scip-query redundant-reexports` |
| Find dead code | `scip-query dead --min-loc 10 --skip-barrels` |
| Codebase health report | `scip-query health` |
| Coupling pressure points | `scip-query bottlenecks` |
| Complexity hotspots | `scip-query complexity-hotspots` |
| Circular dependencies | `scip-query cycles` |
| Pattern drift | `scip-query drift` |
| Unnecessary wrappers | `scip-query wrapper-candidates` |
| Stale abstractions | `scip-query stale-abstractions` |
| Check if a file exists | `Glob` with the exact path pattern |

If none of these can answer your question, say so explicitly in the plan rather than silently falling back to grep.

### Full Documentation

- **Every command with options and examples:** `/Users/aydansalois/Documents/GitHub/scip-query/docs/COMMAND_REFERENCE.md`
- **Goal-oriented agent workflows:** `/Users/aydansalois/Documents/GitHub/scip-query/docs/AGENT_GUIDE.md`

---

## The 11 Principles

After designing the core implementation, stress-test it against every principle below. Each principle is a lens — apply it to every step in the plan and ask whether the design holds up. If it doesn't, add steps until it does. Use scip-query to verify your answers, not assumptions.

### 1. Understand before you touch

Why does this code exist? What production failure shaped it? What does it handle that isn't obvious? You don't earn the right to change something until you can explain why it was written that way.

**Key question**: Can you explain the purpose of every piece of code you're modifying or removing?
**Tools**: `scip-query call-graph <symbol>` for callers/callees. `scip-query code <symbol>` to read the implementation.

### 2. Map the blast radius

Every symbol you change has consumers. Find all of them — direct callers, transitive dependents, tests that mock it, types that reference it, re-exports. The question isn't "what am I changing" — it's "what else moves when I move this."

**Key question**: For every changed symbol, do you know every consumer?
**Tools**: `scip-query affected <symbol>` for full transitive closure. `scip-query rdeps` on every modified file. `scip-query surface` on every modified module. `scip-query change-surface <file>` for a per-file risk briefing.

### 3. Every intermediate state must be valid

You can't teleport from old to new. Every commit, every deploy between here and there must leave the system working. No "it'll work once we finish all the steps." If the migration has 5 phases, each of the 5 intermediate states must build, pass tests, and be deployable.

**Key question**: If you deployed only Phase 1, would the system still work?
**Tools**: `scip-query deps` to verify no phase depends on code that hasn't been written yet.

### 4. Reversibility determines rigor

One-way doors (dropping tables, changing public APIs, deleting data) get maximum scrutiny. Two-way doors (internal refactors, new internal functions) get proportional scrutiny. Know which kind of door you're walking through at every step, and say so in the plan.

**Key question**: For each step, can you undo it? What's the rollback plan if it goes wrong?

### 5. Design for failure, not success

The happy path works — that's the easy part. What happens when the database is slow? The network drops? The API returns garbage? The process crashes mid-write? A user hits the button twice? Every new path needs a concrete failure mode answer.

**Key question**: For every new async path, what's the worst that happens and does the system recover?
**Tools**: `scip-query dataflow <symbol>` to trace data flow through error paths. `scip-query code <symbol>` to read existing catch blocks.

### 6. Assume concurrency

Can this run twice at the same time? Can events arrive out of order? Can state be half-written when something else reads it? Can a cleanup path fire after a retry already recovered? Can a "done" signal arrive before its prerequisite state is written?

**Key question**: What shared mutable state does this touch, and what happens when two things touch it at once?
**Tools**: `scip-query dataflow <symbol>` to find what flows through shared state. `scip-query slice <symbol>` to trace what affects a variable.

### 7. Defend the boundaries

Every entry point — API endpoint, WebSocket message, webhook, CLI command — is a trust boundary. Who can trigger this? On whose resources? With what input? Can user A act on user B's resources? Is the payload validated? Validate at the boundary, trust internally.

**Key question**: For every entry point, who is allowed to call it, and what happens when someone who isn't allowed tries?
**Tools**: `scip-query code <handler>` to read the handler. `scip-query refs <authFunction>` to see where auth middleware is applied.

### 8. Protect data integrity

When you remove something, what references it? Foreign keys, orphaned rows, in-flight operations, unique constraints. When you change a schema, what happens to existing data? Data outlives code — you can revert a deploy but you can't un-corrupt a database.

**Key question**: What happens to existing data during and after this change?
**Tools**: `scip-query refs` on table/column names. `scip-query files` to find schema references.

### 9. Make it observable

When this breaks at 3am, can the on-call engineer diagnose it from logs alone without reading the source code? Every error path needs structured context. Every state transition should be traceable. If you can't tell what happened, you can't fix it.

**Key question**: For every new error path, is there a log line with enough context to diagnose the problem?
**Tools**: `scip-query code <symbol>` to check existing logging patterns.

### 10. Consider the human

What does the user experience during and after this change? Features that disappear without explanation, loading states that lie, error messages that confuse, flows that silently change behavior — these are bugs, not polish items.

**Key question**: If a real user walked through this flow, would anything surprise, confuse, or frustrate them?

### 11. Reuse over re-implement; match what already exists

Two implementations of the same logic is worse than either alone — they drift, diverge, and slowly contradict each other until nobody knows which is canonical. Before designing any new code path, find the existing implementations of the same problem class and reuse them. The codebase already has utilities, error-handling patterns, naming conventions, and abstractions for this — use them. If you genuinely need a new pattern, justify why in the plan with a citation to what existed and why it didn't fit. Your implementation should be indistinguishable from the surrounding code — same patterns, same utilities, same conventions, same libraries.

This principle backstops the Gate C **Reuse Audit** — by stress-test time, every new symbol in the plan should already be tied to a reuse target or a written justification. Use this lens to catch ones that slipped through.

**Key question**: For every new function, type, or module in the plan, does an existing one already do this — or 80% of this? If you'd be writing logic that's *similar-but-not-identical* to existing code, you are creating future drift.
**Tools**: `scip-query similar-chains` (parallel end-to-end flows). `scip-query similar-files` (structurally similar modules). `scip-query similar <symbol>` (overlapping callee sets). `scip-query similar-signatures` (same-shape functions). `scip-query convergence <a> <b>` (merge prescription for near-duplicates). `scip-query surface <module>` (what's already exposed). `scip-query deps <file>` (what libraries are already adopted). `scip-query code <symbol>` (read the canonical example).

---

## Workflow

### 1. Discover — three gates before you design

You may not write a single design step until you have produced written answers to all three gates below. Each gate becomes a section in the final plan. A plan that skips any gate is rejected — it means you don't understand the problem, the system, or what already exists.

#### Gate A — Restate the goal

What is the user actually trying to accomplish? Not the literal request — the underlying job. State it in your own words, then state what "done" looks like for the user (not for the code). If the goal is ambiguous, stop and ask the user before designing. A correct plan for the wrong goal is worse than no plan.

#### Gate B — Explain the current end-to-end flow

Walk the affected slice of the system from entry point to side effect, citing scip-query at every hop. Use:

- `scip-query system <module>` — full module map of the area
- `scip-query call-graph <symbol>` — callers and callees of every entry point you'll touch
- `scip-query trace <symbol>` — definition + signature + every reference
- `scip-query dataflow <symbol>` — what feeds in, where it ends up
- `scip-query change-surface <file>` — pre-change risk briefing on each file you'll modify
- `scip-query affected <symbol>` — full transitive blast radius

If you can't explain how the code works today, you have not earned the right to change it. Surface the non-obvious invariants — what does this code handle that you'd never guess from its shape? What production failures shaped it? What edge cases does the current implementation already cover?

#### Gate C — Reuse audit (search before you write)

For every new function, type, helper, or module you are about to propose, verify the logic doesn't already exist somewhere in the codebase. **Reuse > extend > write-new.** Two implementations of the same logic is worse than either alone — they drift, diverge, and slowly contradict each other.

Run, in roughly broad-to-narrow order:

- `scip-query similar-chains` — does an equivalent end-to-end flow already exist? (the most powerful reuse-finder — catches architectural duplication that function-level checks miss)
- `scip-query similar-files <closest-existing-file>` — does a structurally similar module already exist?
- `scip-query similar <closest-existing-symbol>` — does a function already do most of this? (TF-IDF weighted cosine on callee fingerprints)
- `scip-query similar-signatures` — does a function with this parameter+return shape already exist?
- `scip-query surface <module>` — what utilities does the area you're touching already expose?

Once a candidate surfaces, confirm fit with:

- `scip-query code <candidate>` — read it
- `scip-query convergence <yours> <candidate>` — merge prescription if it's a near-duplicate

The plan must include a **Reuse Audit** subsection. For every new symbol you're proposing, list either (a) the existing function/utility you'll reuse or extend (with scip-query citation), or (b) the specific reason existing code doesn't fit and a new symbol is justified. "I didn't find anything" is not an acceptable answer — name the queries you ran.

### 2. Design

Write the implementation as a numbered checklist grouped into phases (5-8 files max per phase). Each step uses this format:

```markdown
### N.M — Short imperative title

- [ ] **File**: `path/to/file.ts:LINE-LINE`
- **Source**: `scip-query trace <symbol>` (the command that found this)
- **What**: What the code does today (verified via scip-query code).
- **Change**: Exactly what to change. Include code snippets for non-obvious changes.
- **Why**: Why this step is necessary.
```

Include an execution order showing dependencies between phases. Mark which phases can be deployed independently.

### 3. Stress-test

Apply the 11 Principles against every step in the design. For each principle, ask the key question and use the listed scip-query commands to verify the answer. If a principle reveals a gap, add steps to the plan until the gap is closed. Document what you checked and what you found.

### 4. Verify

After stress-testing is complete:

1. **Reindex**: Run `scip-query reindex`.
2. **Verify references**: Spawn parallel subagents (one per phase) using the **Subagent Briefing Template**. Each agent confirms that every file path exists, every line number is within +-5 lines, and every described behavior matches reality. Reject output that doesn't cite scip-query commands.
3. **Fix drift**: Update any stale references.
4. **Check execution order**: No phase depends on a later phase. No step within a phase depends on a later step.
5. **Check validation coverage**: Every behavior-changing step should have a corresponding validation step. Flag gaps in tests, manual checks, or runtime verification.
6. **Run diff-impact**: `scip-query diff-impact` to verify the blast radius matches what the plan predicted.

---

## Subagent Briefing Template

When spawning any subagent for this planning process, **include the following block verbatim** — subagents do not inherit your instructions.

```
## Code Intelligence Tool — Required

You have the `scip-query` CLI for compiler-resolved code intelligence. Use it for ALL code references — do not use grep, rg, Read, or cat.

### scip-query commands

Navigation:
- `scip-query code <symbol>` — read source code (bounded to definition range)
- `scip-query code <symbol> -C 5` — read source with 5 extra context lines
- `scip-query outline <file>` — all symbols in a file with line ranges + signatures
- `scip-query files <pattern>` — find files by name
- `scip-query refs <symbol>` — every file referencing a symbol
- `scip-query trace <symbol>` — definition + signature + all references
- `scip-query call-graph <symbol>` — incoming callers + outgoing callees
- `scip-query system <module>` — full module map: files, symbols, deps in/out
- `scip-query surface <module>` — symbols consumers actually use

Dependencies & Impact:
- `scip-query deps <file>` — files this file depends on
- `scip-query rdeps <file>` — files that depend on this file
- `scip-query affected <symbol>` — transitive closure of breakage
- `scip-query change-surface <file>` — pre-change risk briefing
- `scip-query diff-impact` — git diff impact analysis

Analysis:
- `scip-query complexity <symbol>` — branches, cyclomatic estimate, fan-in/out
- `scip-query dataflow <symbol>` — definition sites, usage sites, producers, consumers
- `scip-query slice <symbol>` — backward slice (what affects this)
- `scip-query slice <symbol> --forward` — forward slice (what this affects)
- `scip-query similar <symbol>` — find functions with similar callee patterns
- `scip-query convergence <a> <b>` — refactoring prescription for similar pair

Quality:
- `scip-query health` — composite codebase health report
- `scip-query dead --min-loc 10` — find dead code
- `scip-query bottlenecks` — coupling pressure points
- `scip-query complexity-hotspots` — riskiest symbols
- `scip-query cycles` — circular dependencies

Full command reference: /Users/aydansalois/Documents/GitHub/scip-query/docs/COMMAND_REFERENCE.md
Agent workflows guide: /Users/aydansalois/Documents/GitHub/scip-query/docs/AGENT_GUIDE.md

### Rules
- Use scip-query for ALL discovery. Do NOT use grep, rg, or Read.
- To read source code, use `scip-query code <symbol>`.
- Every file path, line number, and behavioral claim must cite the specific scip-query command that produced it.
- If you cannot verify a claim with scip-query, say so explicitly — do not guess.
- Your output will be rejected if it contains findings without scip-query citations.
```

**Reject any subagent output that cites grep, rg, cat, or Read as evidence instead of scip-query.**

---

## Output Format

The plan is a single markdown file with:

1. Title and date
2. **Goal** (Gate A — what the user is actually trying to accomplish, what "done" looks like for them)
3. **Current state** (Gate B — end-to-end flow today with scip-query citations, plus the non-obvious invariants the current code already handles)
4. **Reuse audit** (Gate C — for each new symbol proposed, the reuse target or the justification for writing new, with the queries that were run)
5. Design phases (numbered checklists with Source fields)
6. Stress-test findings (inline with the relevant phase or as addenda)
7. Execution order (dependency graph between phases)
8. Ship order (recommended deployment sequence, one-way doors flagged)
9. Summary (files modified/created/deleted, net code delta)
