---
name: scip-directory-architecture
description: Review directory architecture with scip-query evidence. Use to evaluate, design, reorganize, or migrate folder structure, ownership boundaries, locality config, messy repos, AI-generated layout, or safe file-move slices.
commands:
  - template: "scip-query system <scope>"
    when: "Inventory evidence: files, symbols, deps in/out for the scope."
  - template: "scip-query locality-candidates --json --full"
    when: "Inventory evidence: directory-locality candidates from consumer ownership."
  - template: "scip-query similar-files --full --json"
    when: "Inventory evidence: files with overlapping dependency profiles."
  - template: "scip-query cycles"
    when: "Inventory evidence: circular dependency chains between files."
  - template: "scip-query architecture --json"
    when: "Measure configured boundaries, actual dependency traffic, forbidden edges, reciprocal pairs, and boundary cycles."
  - template: "scip-query drift --architecture"
    when: "Review direct drift findings together with boundary coverage and architecture signals."
  - template: "scip-query co-change --json --full"
    when: "Inventory evidence: hidden file-level coupling from git history."
  - template: "scip-query health --write-baseline"
    when: "Record reviewed existing debt before enabling architecture regression enforcement."
  - template: "scip-query diff-gate"
    when: "Verify that the current diff introduces no new declared architecture violation."
  - template: "scip-query config-validate --json"
    when: "Implement a slice: validate locality config after a move."
---

# scip-directory-architecture

Use this skill to answer where code should live. Directory architecture is the filesystem arrangement of source files by their main reason to change; what distinguishes a good structure is that a maintainer can predict where a concept belongs before reading every import.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query system <scope>` | Full module map: files, symbols, deps in/out | Inventory evidence: files, symbols, deps in/out for the scope. |
| `scip-query locality-candidates --json --full` | Find directory-locality and ancestry candidates from consumer ownership | Inventory evidence: directory-locality candidates from consumer ownership. |
| `scip-query similar-files --full --json` | Find heuristic similar-file candidates from dependency profiles | Inventory evidence: files with overlapping dependency profiles. |
| `scip-query cycles` | Detect circular dependency chains between files | Inventory evidence: circular dependency chains between files. |
| `scip-query architecture --json` | Evaluate project-owned architectural boundaries and dependency rules | Measure configured boundaries, actual dependency traffic, forbidden edges, reciprocal pairs, and boundary cycles. |
| `scip-query drift --architecture` | Detect drift candidates: unused imports and declared architecture violations; pass --architecture for boundary context | Review direct drift findings together with boundary coverage and architecture signals. |
| `scip-query co-change --json --full` | Files that change together in git history without a dependency edge — hidden coupling candidates | Inventory evidence: hidden file-level coupling from git history. |
| `scip-query health --write-baseline` | Composite codebase health report with prioritized action list | Record reviewed existing debt before enabling architecture regression enforcement. |
| `scip-query diff-gate` | Gate the current diff: architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates; exit 1 on blocking findings | Verify that the current diff introduces no new declared architecture violation. |
| `scip-query config-validate --json` | Validate .scipquery.json, including structured suppressions and declared coupling groups | Implement a slice: validate locality config after a move. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Terms

An ownership boundary is a folder, package, module, or convention that groups code around one stable responsibility.

A dependency edge points from code that relies on something to the code it relies on. For imports, `A -> B` means A imports B.

A forbidden edge is an actual cross-boundary dependency rejected by an explicit project rule. Directory distance or an unusual import does not make an edge forbidden by itself.

A layer is a responsibility ordered by dependency direction, such as presentation depending on application. A subsystem is a responsibility that owns an end-to-end capability, such as authentication or rendering. A package is a publication or build unit. A service is an independently running unit. Do not force all four into one layer hierarchy.

A reciprocal dependency is dependency traffic in both directions between two boundaries. It is a review signal because the boundaries exert mutual change pressure, not proof that either import is wrong.

An architecture ratchet is an enforcement rule that records existing violations while preventing new ones, allowing a large codebase to improve without a speculative rewrite.

A target structure is a proposed future layout that expresses an ownership model, not merely a prettier tree.

A migration slice is the smallest set of file moves and import updates that can be verified independently.

A slop codebase is a codebase whose files are arranged by accident, convenience, or recent edits rather than stable ownership rules.

## Rules

1. Start with evidence, not taste.
2. Separate review from migration; do not move files unless asked.
3. Preserve broad boundaries when evidence shows they are intentional.
4. Do not reward generic `shared` unless the shared concept has a name, owner, and cross-boundary consumers.
5. For messy repos, produce a discovery map and decisions instead of pretending the target is obvious.
6. Prefer small verified moves.
7. Configure descriptive boundaries before closing dependency rules.
8. Treat graph shape as evidence about responsibilities, never as a substitute for identifying them.

## Workflow

### 1. Bound the question

Classify the request: review, target structure, locality config, migration plan, or implementation.

This step is complete only when the scope and deliverable are explicit.

### 2. Inventory evidence

```bash
scip-query stats
scip-query system <scope>
scip-query files <pattern>
scip-query surface <scope>
scip-query deps <file>
scip-query rdeps <file>
scip-query change-surface <file>
scip-query plan-context <file-or-symbol>
scip-query locality-candidates --json --full
scip-query cycles
scip-query architecture --json
scip-query drift --architecture
scip-query co-change
scip-query similar-files --min-similarity 0.6 --min-deps 3
scip-query similar-chains --min-similarity 0.5
scip-query recent-duplicates
scip-query drift
```

Also read durable project guidance that names architecture, modules, ownership, routes, workflows, contracts, or domains.

This step is complete only when each folder under review has evidence for exports, entry points, consumers, tests, co-change partners, and claimed ownership rules.

### 3. Classify boundary maturity

Classify each candidate:

- Mature: repeated, documented, and enforced by imports, tests, routes, packages, standards, or review history.
- Emerging: meaningful and partly repeated, but not consistent enough to configure.
- Accidental: convenience bucket, legacy pile, generated artifact, recent edit cluster, or mixed reasons to change.

This step is complete only when mature, emerging, and accidental boundaries are separated.

### 4. Build a descriptive architecture model

For a large existing codebase, identify real system units before calling them layers. Inventory:

- workspace packages and public exports;
- applications, services, and deployable entry points;
- domain capabilities and end-to-end subsystems;
- persistence, network, rendering, compiler, and other technical responsibilities;
- tests, routes, contracts, and ownership or architecture documentation;
- dependency and co-change evidence that shows which files already move as a unit.

Add mature boundary path patterns to `.scipquery.json` without `allowedDependencies` rows first:

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

Then run:

```bash
scip-query config-validate --json
scip-query architecture --json
```

Use unmapped and ambiguous files to repair boundary membership. Use actual boundary edges, reciprocal pairs, and strongly connected groups to test whether the names describe real separation.

This step is complete only when every configured boundary has a stated responsibility and the mapping gaps are understood.

### 5. Declare only supported dependency rules

An `allowedDependencies` row is closed: an outgoing target omitted from a present row is forbidden. A missing row makes no dependency claim.

```json
{
  "architecture": {
    "boundaries": [
      { "name": "domain", "paths": ["src/domain/**"] },
      { "name": "runtime", "paths": ["src/runtime/**"] }
    ],
    "allowedDependencies": {
      "domain": [],
      "runtime": ["domain"]
    },
    "requireAcyclic": true
  }
}
```

For each closed row, record the evidence for its intended direction. Do not copy the current dependency graph into the allow-list merely to obtain zero findings. Leave emerging or disputed rows undeclared.

This step is complete only when every forbidden edge is understood as either implementation debt, a false boundary, or a policy mistake.

### 6. Propose structure or decisions

Use this shape:

```markdown
# Directory Architecture Review

## Scope
## Current Structure Map
## Boundary Maturity
## Descriptive Architecture Model
## Dependency Rules
## Forbidden-Edge Ledger
## Reciprocal and Cycle Review
## Target Structure
## Move Ledger
## Locality Config
## No-Move Decisions
## Deferred Decisions
## Migration Order
```

List no-move decisions when broad consumers, route/package/contract surfaces, infrastructure roles, generic shared risk, or weak evidence make a move harmful.

This step is complete only when every proposed move has a reason and verification path.

### 7. Ratchet, then implement one slice when asked

For a large repository with existing violations, review the direct findings and
write the shared health baseline:

```bash
scip-query drift --architecture
scip-query health --write-baseline
```

The baseline records stable architecture identities by boundary pair, not by
whichever example file happens to sort first. The default `scip-query
diff-gate` architecture check then compares only architecture identities; it
does not run every health detector. `diff-gate --baseline` remains the opt-in
full health ratchet and does not duplicate architecture findings.

Commit `.scipquery-baseline.json` with `.scipquery.json`. A missing baseline
causes the architecture gate to report that enforcement is not enabled; it
does not silently treat the current graph as accepted.

Prefer inspecting the least-broad edge inside a boundary cycle first, but
determine whether the repair is a move, dependency inversion, named shared
contract, boundary merge, or policy correction.

Before editing, state files to move, imports/exports/tests/docs to update, expected verification, and rollback risk. Then move the smallest high-confidence slice and run:

```bash
scip-query incomplete-migration
scip-query recent-duplicates
scip-query co-change <moved-file-or-config>
```

Also run project tests or typecheck for the affected workspace. If `.scipquery.json` locality changed, run:

```bash
scip-query config-validate
scip-query locality-candidates --json --full
scip-query architecture --json
scip-query drift --architecture
scip-query diff-gate
```

Then invoke `scip-verify`. The implementation is complete only when imports, tests, locality signals, and verification are checked.
