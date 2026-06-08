---
name: principal-maintainability-review
description: Use when the user asks what a senior, staff, principal, ThePrimeagen-style, or highly opinionated maintainer would notice in a codebase; when they ask for architecture smells, maintainability disgust, "did you vibe code this?", "what is gross here?", "what should be fundamentally different?", or how to find genuine codebase improvements beyond ordinary deduplication. Finds scattered concepts, hidden policies, accidental variation, and compression opportunities, then proposes or executes maintainability-improving refactors.
---

# Principal Maintainability Review

## Purpose

Use this skill to review a codebase from the standpoint of an expert maintainer who is optimizing for future comprehension and change safety, not just correctness, test count, or line count.

A principal maintainability review is an architecture review over real code units such as files, symbols, tests, commands, adapters, caches, public exports, and docs; it identifies where one human concept is scattered across many local implementations and replaces that scatter, when justified, with a smaller named mechanism that preserves behavior.

This differs from a normal refactor because the target is maintainer memory load. The question is not only "is there duplication?" The question is "what hidden concept, policy, lifecycle, or pipeline must a future maintainer rediscover to change this safely?"

## Trigger Posture

When this skill triggers, adopt an evaluative but evidence-grounded stance. The user is asking for taste and judgment, not a neutral file tour.

Translate persona prompts into technical review prompts:

- "What would a principal engineer notice?" means "Which concepts are scattered, undernamed, or locally reimplemented?"
- "Would this look vibe-coded?" means "Where does the structure fail to communicate the domain model or maintenance contract?"
- "What is gross here?" means "Which code shapes create avoidable future mistakes?"
- "What would be fundamentally better?" means "Which smaller mechanism would preserve behavior while reducing concept count?"

Do not mock the code. Be direct about smells, but keep claims tied to concrete evidence.

## Core Concepts

A code smell is an observable codebase fact that predicts avoidable future mistakes because the same knowledge must be rediscovered, synchronized, or defended in several places.

A concept boundary is the line around code units that exist for one reason to change. A weak boundary mixes unrelated reasons to change, such as parsing syntax, choosing fallback policy, caching data, and rendering output in one module.

A hidden policy is a rule for choosing behavior when several plausible behaviors exist, but the rule is implemented through local branches, repeated comments, or caller folklore instead of a named mechanism.

A lifecycle is a repeatable sequence of states or steps that makes a result valid, such as parse -> fallback -> emit, candidate -> evidence -> score -> report, or load -> augment -> write -> invalidate.

Concept count is the number of distinct ideas a maintainer must hold active to make a safe change. Lowering concept count is valuable only when the new structure still explains all real variation.

Accidental variation is difference in code shape that does not correspond to a difference in behavior, domain facts, or external constraints.

Essential variation is difference that must remain because the real-world referents differ, such as different language grammars, API contracts, runtime environments, or public compatibility boundaries.

## Workflow

### 1. State the Review Question

Restate the task in concrete terms:

```text
What future-maintenance mistakes does this structure invite, and what smaller named mechanisms would prevent them without hiding real variation?
```

If the user asks to execute changes, proceed after building enough evidence. If they ask only "what else is there?", return the next ranked smell set and its evidence.

### 2. Build an Evidence Map

Start from real units:

```bash
rg --files
rg -n "<relevant symbol|policy|pattern>" <scope>
scip-query system <scope>
scip-query surface <scope>
scip-query deps <file>
scip-query rdeps <file>
scip-query outline <file>
```

Use smell probes as signals, not verdicts:

```bash
scip-query similar
scip-query similar-files
scip-query extract-candidates
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query drift
scip-query health --json
```

If no SCIP index exists, reindex or fall back to `rg`, tests, build config, and manual code reading.

### 3. Name the Referents

For each suspicious area, identify the concrete referents before judging it:

- files and exported symbols
- callers and downstream public surfaces
- tests and fixtures that define behavior
- data structures and result records
- fallback paths, caches, registries, adapters, and command handlers
- generated artifacts or compatibility constraints

Do not call something a smell until you can point to the code units that make the future-maintenance risk real.

### 4. Ask the Principal Questions

For each cluster, answer:

- What one concept is being implemented in several places?
- What policy is hidden in branches, comments, argument conventions, or test fixtures?
- What lifecycle is present but unnamed?
- Which differences are essential, and which are accidental?
- What must a new maintainer know that the local interface does not admit?
- Would a small named mechanism remove a reason to change, or only move code around?
- What behavior or public API constrains the refactor?

Prefer severe smells in this order:

1. Hidden correctness or evidence policy spread across modules.
2. Repeated lifecycle or pipeline with no named owner.
3. Public surface that exposes accidental internals.
4. Large module with multiple unrelated reasons to change.
5. Tests that encode incident history without a contract vocabulary.
6. Adapter families with repeated capability or fallback shapes.
7. Suppression comments that document architecture decisions instead of exceptions.
8. Thin wrappers, pass-throughs, and helper layers that do not buy clarity.

### 5. Rank by Compression Value

A good target should satisfy most of these:

- It removes a hidden policy or names a lifecycle.
- It reduces the amount of context needed to make future changes.
- It makes tests easier to state as contracts.
- It prevents drift among sibling modules.
- It lowers public API accident risk.
- It deletes, merges, or enforces a real mechanism instead of merely relocating code.

Reject false compression when:

- similar code reflects essential variation
- a helper would hide grammar, protocol, or domain differences
- the new abstraction needs more concepts than it removes
- a compatibility boundary must stay explicit
- the smell is only aesthetic

### 6. Produce a Disgust Register or Atlas

For broad review, create or update a Markdown register under `docs/plans/` unless the user asks not to edit files.

Use this shape:

```markdown
# Principal Maintainability Register

## Executive Read

## Current Status

## Smell Ledger

| Priority | Smell | Evidence | Why it hurts | Better shape | Disposition |
| --- | --- | --- | --- | --- | --- |

## Next Slice

## Deferred Boundaries

## Verification Plan
```

For implementation work, create an atlas for the chosen slice before editing:

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

### 7. Implement Conservatively

When asked to fix the smells:

- Introduce the smallest named mechanism that matches the real concept.
- Keep essential variation close to the adapter or domain code that knows it.
- Move hidden policies behind interfaces that make the choice visible.
- Preserve behavior before broadening scope.
- Update docs/registers to record deferred boundaries and why.
- Commit coherent slices after verification when the user asked for commits.

Avoid "frameworking." A new abstraction is justified only if it removes real concept count or enforces a policy that callers were already hand-maintaining.

### 8. Verify the Review Did Real Work

After changes, run the narrow tests for the touched subsystem and the repository's standard checks. If this repo's SCIP CLI is available, include:

```bash
scip-query health --json
scip-query drift
scip-query stale-abstractions --include-low-confidence
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query similar-files
```

The final answer should say:

- the named smell addressed
- the mechanism introduced or simplified
- what was deliberately not compressed
- verification results
- commit hash, when committed

## Output Style

Be candid and specific. Use plain engineering language:

- "This module has three reasons to change."
- "This helper names a policy that was previously caller folklore."
- "This similarity is false; the syntax differences are essential."
- "This is a good next slice because it removes a lifecycle repeated across sibling adapters."

Do not rely on persona language in the final artifact. The persona is a prompt for judgment; the deliverable is an evidence-backed maintainability review.
