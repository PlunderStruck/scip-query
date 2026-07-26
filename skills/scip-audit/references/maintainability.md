# Maintainability: hidden policy, scattered concepts, weak boundaries

Maintainability is the degree to which real code units let a maintainer
understand, verify, and change behavior without rediscovering hidden
knowledge. Use for hidden policies, scattered concepts, accidental
variation, weak boundaries, system compression, architecture smells, and
structural refactor opportunities beyond a health score.

Ground all claims in files, symbols, references, call graphs, dependencies,
surfaces, and blast radius rather than opinion. Do not chase health scores —
detector counts are clues, not objectives. Name concrete referents (specific
files/symbols) before naming a code smell. Only add an abstraction when it
removes hidden policy, names a lifecycle, enforces a rule, or reduces
concept count — never for its own sake; prefer deletion, inlining, merging,
generation, or enforcement of an existing mechanism before introducing a
broad new framework.

## Vocabulary

- **Code smell** — an observable codebase fact that predicts avoidable
  future mistakes because the same knowledge must be rediscovered,
  synchronized, or defended in more than one place.
- **Concept boundary** — the line around code units that exist for one
  reason to change.
- **Hidden policy** — a rule for choosing among several plausible behaviors
  that lives in local branches, comments, conventions, or caller folklore
  instead of a named mechanism.
- **Lifecycle** — a repeatable sequence of states or steps that makes a
  result valid.
- **Accidental variation** — difference in code shape that does not
  correspond to behavior, domain facts, runtime constraints, or external
  contracts.
- **Essential variation** — difference that must remain because the real
  units differ: language grammars, user-visible APIs, runtime environments,
  or compatibility boundaries. Preserve it; do not remove it.
- **System compression** — replacing several mechanisms that perform the
  same role, policy, lifecycle, or surface job with fewer named mechanisms
  that preserve behavior.
- **Unifying definition** — the single essential trait that makes several
  code sites one concept. Any scattered-concept or consolidation claim must
  ship its unifying definition; if no such trait covers every cited site,
  the variation is essential and the sites must not be consolidated. Failing
  to state it proves the sites are not one concept — consolidating anyway
  packages essential variation into a false abstraction.

## Step 1 — Bound the review

Restate the review question as: "What future-maintenance mistakes does this
structure invite, and what smaller named mechanisms would prevent them
without hiding real variation?" Name the scope as one of: repo, module,
command family, query family, runtime surface, fixture set, or feature path.

**Complete when:** the review question and scope are both concrete.

## Step 2 — Map evidence

Run, in sequence: `scip-query stats`, `system <scope>`, `surface <scope>`,
`files <pattern>`, `outline <file>`, `deps <file>`, `rdeps <file>`, `trace
<symbol>`, `call-graph <symbol>`, `affected <symbol>`, `change-surface
<file>`.

- `stats` maps repo-wide index size before bounding the review (complete
  coverage).
- `system <scope>` gives the full module map — files, exported symbols with
  line ranges, internal deps, reverse deps (complete coverage).
- `surface <scope>` shows which symbols consumers actually use — consumer
  paths and consumed symbol identities (complete coverage).
- `change-surface <file>` gives a pre-change briefing of defined symbols,
  external consumer counts, and risk levels (bounded coverage).
- `affected <symbol>` computes the transitive closure of symbols that could
  break if a candidate symbol changes (bounded coverage).
- `drift --patterns --architecture` finds drift candidates — unused imports
  plus declared architecture boundary violations (bounded coverage; opt-in
  pattern hits are leads, not confirmed findings).

Use the cleanup-oriented commands `health`, `similar`, `similar-files`,
`similar-chains`, `extract-candidates`, `wrapper-candidates`,
`passthrough-candidates`, `stale-abstractions`, `drift`, and `cycles` as
evidence-gathering probes during this step, not as final verdicts.

**Complete when:** concrete units, consumers, tests, fallbacks, adapters,
generated artifacts, and compatibility constraints are all visible.

## Step 3 — Build the role inventory

For each cluster, ask what one concept appears in several places and what
single essential trait makes them one concept — if the trait cannot be
stated, they are not one concept. Also ask: what policy is hidden, what
lifecycle is unnamed, which differences are essential, what must a
maintainer know that the local interface does not admit, and would a
smaller mechanism remove a reason to change, versus merely move code?

**Complete when:** every candidate smell names its referents and its
future-maintenance failure mode.

## Step 4 — Rank pressure

Severity tiers, most to least severe:

1. Hidden correctness or evidence policy spread across modules.
2. A repeated lifecycle or pipeline with no owner.
3. Public surface exposing accidental internals.
4. A large module with unrelated reasons to change.
5. Tests that encode incident history without contract vocabulary.
6. Adapter families with repeated capability or fallback shapes.
7. Suppression comments that document architecture decisions instead of
   exceptions.
8. Thin wrappers and passthroughs that do not buy clarity.

Reject and do not act on smells that are aesthetic, unverifiable, or false
compression.

**Complete when:** each target is ranked, skipped, or deferred with
evidence.

## Step 5 — Choose a model

For substantial changes, compare at least two of three models:

- **Conservative** — delete or inline local bloat.
- **Shape-level** — introduce one small mechanism for a repeated role or
  lifecycle.
- **Radical** — replace a scattered surface with metadata, generation, or
  enforced policy.

Evaluate: behavior preserved, concept count removed, blast radius, deletion
potential, false-abstraction failure mode, migration path, and verification
cost.

**Complete when:** the chosen model removes a concept or policy duplication
rather than merely extracting a helper.

## Step 6 — Produce a register or atlas

For a broad review, write a register under `docs/plans/` unless the user
asks not to edit files; for an implementation, write an atlas before
editing.

Dispositions: merge, delete, inline, extract, generate, enforce, supersede,
defer, skip.

Every merge, extract, or generate entry must carry its unifying definition
and its strongest dissenter (the cited site most likely to differ
essentially), plus evidence that the dissenter does not actually differ
essentially. If a dissenter survives review (it really does differ
essentially), the entry moves to disposition `skip` with reason "essential
variation" — but the dissenter stays recorded in the register either way.

**Complete when:** each opportunity has evidence, disposition, dependency
order, touch map, and validation plan recorded.

## Step 7 — Implement and verify (when asked)

Implement the smallest named mechanism that matches the real concept, and
keep essential variation near the adapter or domain code that knows it.
After implementing, run focused tests and the routed postchecks from
`scip-verify`, then complete that verification skill.

## Report

State the smell addressed, the mechanism introduced or removed, what was
deliberately not compressed, and verification results.
