# Directory architecture: boundaries, locality, and safe moves

Evaluate, design, reorganize, or migrate folder structure, ownership
boundaries, locality config, messy repos, AI-generated layout, or safe
file-move slices.

Command shortlist: `system <scope>`, `locality-candidates --json --full`,
`similar-files --full --json`, `cycles`, `architecture --json`, `drift
--architecture`, `co-change --json --full`, `health --write-baseline`,
`diff-gate`, `config-validate --json`.

## Definitions

- **Ownership boundary** — a folder, package, module, or convention that
  groups code around one stable responsibility.
- **Dependency edge** — points from code that relies on something to the
  code it relies on; for imports, A → B means A imports B.
- **Forbidden edge** — an actual cross-boundary dependency rejected by an
  explicit project rule. Directory distance or an unusual import alone does
  not make an edge forbidden.
- **Layer** — a responsibility ordered by dependency direction, such as
  presentation depending on application.
- **Subsystem** — a responsibility that owns an end-to-end capability, such
  as authentication or rendering.
- **Package** — a publication or build unit. **Service** — an independently
  running unit. Do not force the layer, subsystem, package, and service
  concepts all into one single layer hierarchy.
- **Reciprocal dependency** — dependency traffic in both directions between
  two boundaries; it is a review signal because the boundaries exert mutual
  change pressure, not proof that either import is wrong.
- **Architecture ratchet** — an enforcement rule that records existing
  violations while preventing new ones, allowing a large codebase to improve
  without a speculative rewrite.
- **Target structure** — a proposed future layout that expresses an
  ownership model, not merely a prettier tree.
- **Migration slice** — the smallest set of file moves and import updates
  that can be verified independently.
- **Slop codebase** — one whose files are arranged by accident, convenience,
  or recent edits rather than stable ownership rules.

## Operating principles

Start with evidence, not taste. Separate review from migration — do not move
files unless asked. Preserve broad boundaries when evidence shows they are
intentional; do not reward a generic "shared" boundary/directory unless the
shared concept has a name, owner, and cross-boundary consumers. For messy
repos, produce a discovery map and decisions instead of pretending the
target structure is obvious. Prefer small verified moves over large
speculative reorganizations. Configure descriptive boundaries before closing
(declaring) dependency rules. Treat graph shape (dependency structure) as
evidence about responsibilities, never as a substitute for identifying them.

## Step 1 — Bound the question

Classify the request as review, target structure, locality config,
migration plan, or implementation.

**Complete when:** scope and deliverable are explicit.

## Step 2 — Inventory evidence

Run `stats`, `system <scope>`, `files <pattern>`, `surface <scope>`, `deps
<file>`, `rdeps <file>`, `change-surface <file>`, `plan-context
<file-or-symbol>`, `locality-candidates --json --full`, `cycles`,
`architecture --json`, `drift --architecture`, `co-change`, `similar-files
--min-similarity 0.6 --min-deps 3`, `similar-chains --min-similarity 0.5`,
`recent-duplicates`, and `drift`.

- `system <scope>` returns module file paths, exported symbols with line
  ranges, internal dependencies, and reverse dependencies.
- `locality-candidates --json --full` returns directory-locality and
  ancestry candidates from consumer ownership — symbols, current homes,
  consumer locality, and suggested homes.
- `similar-files --full --json` returns file pairs with similarity scores
  and shared symbols (overlapping dependency profiles).
- `cycles` detects circular dependency chains between files.
- `architecture --json` measures configured boundaries, actual dependency
  traffic, forbidden edges, reciprocal pairs, and boundary cycles.
- `drift --architecture` reviews direct drift findings together with
  boundary coverage and architecture signals.
- `co-change --json --full` inventories hidden file-level coupling from git
  history — files that change together without a dependency edge.

Also read durable project guidance that names architecture, modules,
ownership, routes, workflows, contracts, or domains.

**Complete when:** each folder under review has evidence for exports, entry
points, consumers, tests, co-change partners, and claimed ownership rules.

## Step 3 — Classify boundary maturity

Classify each boundary candidate as:

- **Mature** — repeated, documented, and enforced by imports, tests,
  routes, packages, standards, or review history.
- **Emerging** — meaningful and partly repeated but not consistent enough
  to configure.
- **Accidental** — a convenience bucket, legacy pile, generated artifact,
  recent edit cluster, or mixed reasons to change.

**Complete when:** mature, emerging, and accidental boundaries are
separated.

## Step 4 — Build a descriptive architecture model

For a large existing codebase, before calling anything a "layer," inventory:
workspace packages/public exports; applications/services/deployable entry
points; domain capabilities/end-to-end subsystems;
persistence/network/rendering/compiler/other technical responsibilities;
tests/routes/contracts/ownership or architecture documentation; and
dependency/co-change evidence showing which files already move as a unit.

Add mature boundary path patterns to `.scipquery.json` under
`architecture.boundaries` WITHOUT `allowedDependencies` rows first:

```json
{
  "architecture": {
    "boundaries": [
      { "name": "domain", "paths": ["src/domain/**"] },
      { "name": "runtime", "paths": ["src/runtime/**"] }
    ]
  }
}
```

After adding boundaries, run `scip-query config-validate --json` then
`scip-query architecture --json` to check the new boundary configuration.
Use unmapped and ambiguous files to repair boundary membership, and use
actual boundary edges, reciprocal pairs, and strongly connected groups to
test whether boundary names describe real separation.

**Complete when:** every configured boundary has a stated responsibility and
the mapping gaps are understood.

## Step 5 — Declare only supported dependency rules

An `allowedDependencies` row is closed: an outgoing target omitted from a
present row is forbidden, but a missing row makes no dependency claim at
all. Example closed config:

```json
{
  "architecture": {
    "boundaries": [ ... ],
    "allowedDependencies": {
      "domain": [],
      "runtime": ["domain"]
    },
    "requireAcyclic": true
  }
}
```

For each closed `allowedDependencies` row, record the evidence for its
intended direction. Do not copy the current dependency graph into the
allow-list merely to obtain zero findings. Leave emerging or disputed
dependency rules undeclared rather than closing the row prematurely.

**Complete when:** every forbidden edge is understood as either
implementation debt, a false boundary, or a policy mistake.

## Step 6 — Propose structure or decisions

Structure a directory architecture review/proposal using this exact section
order:

1. Scope
2. Current Structure Map
3. Boundary Maturity
4. Descriptive Architecture Model
5. Dependency Rules
6. Forbidden-Edge Ledger
7. Reciprocal and Cycle Review
8. Target Structure
9. Move Ledger
10. Locality Config
11. No-Move Decisions
12. Deferred Decisions
13. Migration Order

List a decision as No-Move when broad consumers, route/package/contract
surfaces, infrastructure roles, generic shared risk, or weak evidence make a
move harmful.

**Complete when:** every proposed move has a reason and a verification path.

## Step 7 — Ratchet, then implement one slice (when asked)

For a large repository with existing violations, review the direct findings
with `scip-query drift --architecture` and write the shared health baseline
with `scip-query health --write-baseline`. The baseline records stable
architecture identities by boundary pair, not by whichever example file
happens to sort first.

The default `scip-query diff-gate` architecture check compares only
architecture identities and does not run every health detector; `diff-gate
--baseline` is the opt-in full health ratchet and does not duplicate
architecture findings. Commit `.scipquery-baseline.json` together with
`.scipquery.json`. A missing baseline causes the architecture gate to report
that enforcement is not enabled — it does NOT silently treat the current
dependency graph as accepted.

Prefer inspecting the least-broad edge inside a boundary cycle first, then
determine whether the repair is a move, dependency inversion, named shared
contract, boundary merge, or policy correction.

Before editing to implement a migration slice, state the files to move, the
imports/exports/tests/docs to update, the expected verification, and the
rollback risk.

After moving the smallest high-confidence slice, run `scip-query
incomplete-migration`, `scip-query recent-duplicates`, and `scip-query
co-change <moved-file-or-config>`. Also run the project's tests or typecheck
for the affected workspace.

If `.scipquery.json` locality changed, run `scip-query config-validate`,
`scip-query locality-candidates --json --full`, `scip-query architecture
--json`, `scip-query drift --architecture`, and `scip-query diff-gate`.

Then invoke `scip-verify`; the implementation is complete only when imports,
tests, locality signals, and verification are checked.
