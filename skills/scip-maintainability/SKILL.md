---
name: scip-maintainability
description: Principled maintainability review using scip-query. Finds hidden policies, scattered concepts, accidental variation, weak boundaries, and system-compression opportunities, then proposes or executes structural improvements and verifies post-change wiring without chasing health scores.
---

# SCIP Maintainability Review

You are reviewing a codebase from the standpoint of a senior maintainer. The goal is not to maximize a metric. The goal is to make future changes easier to understand and safer to execute by tying every claim to `scip-query` evidence and by improving the structure that real maintainers must reason about.

A maintainability review is an architecture review over real code units such as files, symbols, commands, adapters, caches, public exports, tests, and docs. It identifies where one human concept is scattered across several mechanisms, where policy lives in caller folklore, and where accidental variation makes future edits harder than they need to be.

System compression belongs inside this review. A system compression is a maintainability improvement that replaces several mechanisms performing the same role, policy, lifecycle, or public-surface job with fewer named mechanisms that preserve behavior.

---

## When to Use This Skill

- "What would a principal engineer notice?"
- "What is gross here?"
- "Did this look vibe-coded?"
- "How should we simplify this architecture?"
- "Find deeper maintainability problems"
- "What hidden policies or concepts are scattered?"
- "Compress this system"
- "Find the refactor that actually makes this easier to maintain"

---

## Hard Rules

1. **Evidence first.** Use `scip-query` to ground claims in files, symbols, references, call graphs, dependencies, surfaces, and blast radius. Check `scip-query status --capabilities`; if freshness is `stale`, `missing`, or `unknown`, run `scip-query reindex` before trusting graph facts.

2. **Do not chase health scores.** `scip-query health`, detector counts, and LOC estimates are diagnostic signals. They are not the objective. A change is valuable only when it reduces real maintenance burden while preserving behavior.

3. **Name the referents before naming the smell.** A smell is not real until you can point to the concrete files, symbols, tests, or public surfaces that make the future-maintenance risk real.

4. **Preserve essential variation.** Do not compress code merely because it looks similar. Different language grammars, runtime contracts, compatibility boundaries, public APIs, or domain rules may justify different code.

5. **Reject false abstractions.** A new abstraction is justified only when it removes a hidden policy, names a lifecycle, enforces a rule callers were hand-maintaining, or reduces the concept count required for safe change.

6. **Prefer small named mechanisms.** Delete, inline, merge, generate, or enforce before adding broad frameworks.

7. **Treat suppressions as accepted design records.** Prefer fixing findings.
   Use `scip-query suppress <id> --reason "<specific reason>"` only for
   intentional design, compatibility shims, framework entry points, or accepted
   false positives. Run `scip-query config-validate` afterward.

---

## Core Concepts

A code smell is an observable codebase fact that predicts avoidable future mistakes because the same knowledge must be rediscovered, synchronized, or defended in more than one place.

A concept boundary is the line around code units that exist for one reason to change. A weak boundary mixes unrelated reasons to change, such as parsing syntax, choosing fallback policy, caching data, and rendering output in one module.

A hidden policy is a rule for choosing behavior when several plausible behaviors exist, but the rule is implemented through local branches, repeated comments, naming conventions, or caller folklore instead of a named mechanism.

A lifecycle is a repeatable sequence of states or steps that makes a result valid, such as parse -> fallback -> emit, candidate -> evidence -> score -> report, or load -> augment -> write -> invalidate.

Accidental variation is difference in code shape that does not correspond to a difference in behavior, domain facts, runtime constraints, or external contracts.

Essential variation is difference that must remain because the real-world units differ, such as different language grammars, indexer capabilities, user-visible APIs, runtime environments, or compatibility boundaries.

Concept count is the number of distinct ideas a maintainer must keep active to make a safe change. Lowering concept count is valuable only when the new structure still explains all real variation.

---

## Workflow

### 1. Bound the Review

Restate the question in concrete terms:

```text
What future-maintenance mistakes does this structure invite, and what smaller named mechanisms would prevent them without hiding real variation?
```

Identify the scope: whole repo, module, command family, query family, runtime surface, test fixture set, or one feature path.

### 2. Refresh and Map Evidence

Start from current code intelligence:

```bash
scip-query status
scip-query status --capabilities      # Reindex only when freshness is stale, missing, or unknown
scip-query stats
scip-query system <scope>
scip-query surface <scope>
```

Then map the concrete units:

```bash
scip-query files <pattern>
scip-query outline <file>
scip-query outline <file>
scip-query deps <file>
scip-query rdeps <file>
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query affected <symbol>
scip-query change-surface <file>
```

Use cleanup commands as probes, not verdicts:

```bash
scip-query health --json
scip-query similar
scip-query similar-files
scip-query similar-chains
scip-query extract-candidates
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions --include-low-confidence
scip-query drift
scip-query cycles
```

### 3. Build a Role Inventory

For each important cluster, record:

- concrete files and exported symbols
- callers and downstream public surfaces
- tests and fixtures that define behavior
- fallback paths, caches, registries, adapters, and command handlers
- generated artifacts or compatibility constraints
- the role each unit plays in the workflow

Ask:

- What one concept is being implemented in several places?
- What policy is hidden in branches, comments, argument conventions, or test fixtures?
- What lifecycle is present but unnamed?
- Which differences are essential, and which are accidental?
- What must a new maintainer know that the local interface does not admit?
- Would a smaller named mechanism remove a reason to change, or only move code around?

### 4. Rank Maintainability Pressure

Prefer severe smells in this order:

1. Hidden correctness or evidence policy spread across modules.
2. Repeated lifecycle or pipeline with no named owner.
3. Public surface that exposes accidental internals.
4. Large module with multiple unrelated reasons to change.
5. Tests that encode incident history without contract vocabulary.
6. Adapter families with repeated capability or fallback shapes.
7. Suppression comments that document architecture decisions instead of exceptions.
8. Thin wrappers, pass-throughs, and helper layers that do not buy clarity.

Reject a target when:

- similar code reflects essential variation
- the new abstraction needs more concepts than it removes
- a compatibility boundary must stay explicit
- the smell is only aesthetic
- the behavior cannot be verified

### 5. Choose a Compression Model

For substantial changes, compare at least two models:

- conservative: delete or inline local bloat without changing ownership
- shape-level: introduce one small mechanism that owns a repeated role or lifecycle
- radical: replace a scattered surface with metadata, generation, or an enforced policy

Evaluate each model by:

- behavior preserved
- concept count removed
- blast radius from `affected`, `change-surface`, `deps`, and `rdeps`
- deletion potential
- failure mode if the abstraction is false
- migration path and verification cost

Choose the model that removes a concept or policy duplication, not the model that merely extracts a helper.

### 6. Produce a Register or Atlas

For broad review, create or update a register under `docs/plans/` unless the user asks not to edit files:

```markdown
# SCIP Maintainability Register

## Executive Read
## Scope Map
## Smell Ledger

| Priority | Smell | Evidence | Why it hurts | Better shape | Disposition |
| --- | --- | --- | --- | --- | --- |

## Compression Opportunities
## Deferred Boundaries
## Verification Plan
```

For implementation work, create an atlas before editing:

```markdown
# <Scope> Maintainability Atlas

## Scope Map
## Role Inventory
## Hidden Policies
## Essential vs Accidental Variation
## Opportunity Ledger
## Dependency Order
## Touch Map
## Validation Plan
```

Use dispositions:

- `merge`: combine mechanisms with the same role
- `delete`: remove proven unused or replaced code
- `inline`: remove a wrapper, adapter, or single-use abstraction
- `extract`: isolate a real shared role that multiple consumers need
- `generate`: derive a surface from metadata instead of maintaining it by hand
- `enforce`: centralize a policy or invariant so callers cannot drift
- `supersede`: absorb a local issue into a larger cluster
- `defer`: keep visible but out of scope because of a verified blocker
- `skip`: reject because the compression is false or net-negative

### 7. Implement Conservatively

When asked to fix the smells:

- introduce the smallest named mechanism that matches the real concept
- keep essential variation close to the adapter or domain code that knows it
- move hidden policies behind interfaces that make the choice visible
- preserve behavior before broadening scope
- update registers or docs to record deferred boundaries and why

### 8. Verify the Work

Run focused tests for touched code and repeat the structural probes that motivated the change:

```bash
scip-query health --json
scip-query drift
scip-query stale-abstractions --include-low-confidence
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query similar-files
```

Then run the post-change checks that match what the fix actually did:

| Change made | Required post-check |
| --- | --- |
| Extracted a helper, hook, composable, component logic, or named abstraction | `scip-query incomplete-migration`; migrate every unchanged site that still contains the extracted logic or document essential variation |
| Added a new helper, module, component, hook, or composable | `scip-query similar <new-symbol>` when symbol-like, plus `scip-query recent-duplicates --full`; delete echoes of established code |
| Consolidated duplicated files, command handlers, adapters, or workflows | rerun the detector that motivated the change: `similar-files`, `similar-chains`, `wrapper-candidates`, `passthrough-candidates`, frontend duplicate commands, or `health` |
| Added parameters, options, config flags, props, or broad option objects | `scip-query unused-params`; remove speculative inputs that no body uses |
| Added a wrapper, adapter, facade, re-export, or forwarding layer | `scip-query wrapper-candidates`, `scip-query passthrough-candidates`, and `scip-query redundant-reexports` when exports changed |
| Added an interface, base class, type alias, or abstraction boundary | `scip-query stale-abstractions --include-low-confidence`; prove the abstraction has real consumers and policy |
| Changed schema, config, generated files, command descriptors, package surface, or docs-backed behavior | `scip-query co-change <file>` and `scip-query doc-drift`; update historical partners and stale docs |
| Deleted code | `scip-query cleanup-plan --verify`; take the compiler-proven cascade or explain why not |

Always finish implemented maintainability work with:

```bash
scip-query diff-impact --json
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query diff-gate --json
```

Treat `diff-gate` findings as unfinished work. Fix them or state a concrete acceptance reason; do not silently report success.

Report:

- the named smell addressed
- the mechanism introduced, deleted, or simplified
- what was deliberately not compressed
- verification results, including the post-change checks that matched the edit
- commit hash, when committed

---

## Output Style

Be candid, specific, and evidence-grounded:

- "This module has three reasons to change."
- "This helper names a policy that was previously caller folklore."
- "This is false compression because the two adapters differ by runtime contract."
- "The health score changed, but that is a side effect, not the reason this was worth doing."
