---
name: scip-maintainability
description: Review maintainability with scip-query evidence. Use for hidden policies, scattered concepts, accidental variation, weak boundaries, system compression, architecture smells, structural refactors, or maintainability improvements beyond health scores.
---

# scip-maintainability

Use this skill to review a codebase as a maintainer who must make future changes safely. Maintainability is the degree to which real code units let a maintainer understand, verify, and change behavior without rediscovering hidden knowledge.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## Terms

A code smell is an observable codebase fact that predicts avoidable future mistakes because the same knowledge must be rediscovered, synchronized, or defended in more than one place.

A concept boundary is the line around code units that exist for one reason to change.

A hidden policy is a rule for choosing behavior when several plausible behaviors exist, but the rule lives in local branches, comments, conventions, or caller folklore instead of a named mechanism.

A lifecycle is a repeatable sequence of states or steps that makes a result valid.

Accidental variation is difference in code shape that does not correspond to behavior, domain facts, runtime constraints, or external contracts.

Essential variation is difference that must remain because the real units differ: language grammars, user-visible APIs, runtime environments, or compatibility boundaries.

System compression is replacing several mechanisms that perform the same role, policy, lifecycle, or surface job with fewer named mechanisms that preserve behavior.

## Rules

1. Ground claims in files, symbols, references, call graphs, dependencies, surfaces, and blast radius.
2. Do not chase health scores; detector counts are clues, not objectives.
3. Name concrete referents before naming the smell.
4. Preserve essential variation.
5. Add an abstraction only when it removes hidden policy, names a lifecycle, enforces a rule, or reduces concept count.
6. Prefer deletion, inlining, merging, generation, or enforcement before broad frameworks.

## Workflow

### 1. Bound the review

Restate the question:

```text
What future-maintenance mistakes does this structure invite, and what smaller named mechanisms would prevent them without hiding real variation?
```

Name the scope: repo, module, command family, query family, runtime surface, fixture set, or feature path.

This step is complete only when the review question and scope are concrete.

### 2. Map evidence

```bash
scip-query stats
scip-query system <scope>
scip-query surface <scope>
scip-query files <pattern>
scip-query outline <file>
scip-query deps <file>
scip-query rdeps <file>
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query affected <symbol>
scip-query change-surface <file>
```

Use cleanup commands as probes: `health`, `similar`, `similar-files`, `similar-chains`, `extract-candidates`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `drift`, and `cycles`.

This step is complete only when concrete units, consumers, tests, fallbacks, adapters, generated artifacts, and compatibility constraints are visible.

### 3. Build the role inventory

For each cluster, ask:

- What one concept appears in several places?
- What policy is hidden?
- What lifecycle is unnamed?
- Which differences are essential?
- What must a maintainer know that the local interface does not admit?
- Would a smaller mechanism remove a reason to change, or only move code?

This step is complete only when every candidate smell names its referents and its future-maintenance failure mode.

### 4. Rank pressure

Prefer severe smells in this order:

1. Hidden correctness or evidence policy spread across modules.
2. Repeated lifecycle or pipeline with no owner.
3. Public surface exposing accidental internals.
4. Large module with unrelated reasons to change.
5. Tests that encode incident history without contract vocabulary.
6. Adapter families with repeated capability or fallback shapes.
7. Suppression comments that document architecture decisions instead of exceptions.
8. Thin wrappers and passthroughs that do not buy clarity.

Reject smells that are aesthetic, unverifiable, or false compression.

This step is complete only when each target is ranked, skipped, or deferred with evidence.

### 5. Choose a model

For substantial changes, compare at least two models:

- Conservative: delete or inline local bloat.
- Shape-level: introduce one small mechanism for a repeated role or lifecycle.
- Radical: replace a scattered surface with metadata, generation, or enforced policy.

Evaluate behavior preserved, concept count removed, blast radius, deletion potential, false-abstraction failure mode, migration path, and verification cost.

This step is complete only when the chosen model removes a concept or policy duplication rather than merely extracting a helper.

### 6. Produce a register or atlas

For broad review, write a register under `docs/plans/` unless the user asks not to edit files. For implementation, write an atlas before editing.

Use dispositions: `merge`, `delete`, `inline`, `extract`, `generate`, `enforce`, `supersede`, `defer`, `skip`.

This step is complete only when each opportunity has evidence, disposition, dependency order, touch map, and validation plan.

### 7. Implement and verify when asked

Implement the smallest named mechanism that matches the real concept. Keep essential variation near the adapter or domain code that knows it. After changes, run focused tests and routed postchecks from the shared reference, then invoke `scip-verify`.

Report the smell addressed, mechanism introduced or removed, what was deliberately not compressed, and verification results.
