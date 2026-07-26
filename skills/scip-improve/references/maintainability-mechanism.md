# Implementing a maintainability mechanism (absorbs scip-maintainability, act half)

Use to implement a confirmed maintainability opportunity: a register or atlas entry that names a hidden policy, an unnamed lifecycle, or scattered concepts, and proposes a disposition. Maintainability is the degree to which real code units let a maintainer understand, verify, and change behavior without rediscovering hidden knowledge. If there is no confirmed register entry yet, run the `scip-maintainability` skill's review first — this reference starts from its output.

## Vocabulary you need to act correctly

- **Concept boundary** — the line around code units that exist for one reason to change.
- **Hidden policy** — a rule for choosing among several plausible behaviors that lives in local branches, comments, conventions, or caller folklore instead of a named mechanism.
- **Lifecycle** — a repeatable sequence of states or steps that makes a result valid.
- **Essential variation** — difference that must remain because the real units differ: language grammars, user-visible APIs, runtime environments, compatibility boundaries. **Accidental variation** — difference in code shape that doesn't correspond to any of those. Preserve the former; remove the latter.
- **System compression** — replacing several mechanisms that perform the same role, policy, lifecycle, or surface job with fewer named mechanisms, preserving behavior.
- **Unifying definition** — the single essential trait that makes several code sites one concept. A merge, extract, or generate action is only justified when you can state this trait and it covers every cited site; if it doesn't, the variation is essential and those sites must not be consolidated.

Ground every action in files, symbols, references, call graphs, dependencies, surfaces, and blast radius — never opinion. Name concrete referents before naming a smell. Don't chase health scores; detector counts are clues, not objectives. Only add an abstraction when it removes hidden policy, names a lifecycle, enforces a rule, or reduces concept count — never for its own sake. Prefer deletion, inlining, merging, generation, or enforcement of an existing mechanism before introducing a broad new framework.

## Priority when several confirmed entries compete

Rank by severity tier, most severe first: (1) hidden correctness or evidence policy spread across modules, (2) a repeated lifecycle/pipeline with no owner, (3) public surface exposing accidental internals, (4) a large module with unrelated reasons to change, (5) tests that encode incident history without contract vocabulary, (6) adapter families with repeated capability/fallback shapes, (7) suppression comments documenting architecture decisions instead of exceptions, (8) thin wrappers/passthroughs that don't buy clarity. Reject and don't act on smells that are aesthetic, unverifiable, or false compression.

## Confirming a candidate before you touch code

- `scip-query extract-candidates` finds heuristic extraction candidates from isolated callee clusters. When the register calls for extracting a shared helper, run this to confirm the callee cluster, then read every cited site to check the unifying definition actually holds.
- `scip-query passthrough-candidates` finds heuristic passthrough candidates that forward to one callee. When the disposition is inline or delete, run this to confirm the passthrough is real before removing it.
- `scip-query wrapper-candidates` and `scip-query stale-abstractions` find, respectively, single-consumer wrappers and 0–1-consumer abstractions — both have near-zero precision on codebases with intentional layering or ambient types. Treat every hit as exploration, never a finding; run them only after the main sweep is exhausted; never act on a hit without reading the cited code first, and confirm real consumer counts with `refs`/`surface` before deciding a disposition.
- `scip-query redundant-reexports` finds barrel re-exports that nobody imports through. When the disposition is delete, confirm no import path actually uses the barrel, then remove the re-export and update any doc or index that referenced it.

## Dispositions

merge, delete, inline, extract, generate, enforce, supersede, defer, skip. Every merge/extract/generate action must carry its unifying definition and its strongest dissenter — the cited site most likely to differ essentially — plus evidence that the dissenter doesn't actually differ essentially. If a dissenter survives review (it really does differ essentially), the entry's disposition becomes skip with reason "essential variation," but the dissenter stays recorded either way.

## Implement

Implement the smallest named mechanism that matches the real concept. Keep essential variation near the adapter or domain code that knows it, not buried inside the new mechanism.

## Verify and report

Run focused tests, then the routed postchecks from `scip-verify`. The final report states the smell addressed, the mechanism introduced or removed, what was deliberately not compressed, and the verification results.
