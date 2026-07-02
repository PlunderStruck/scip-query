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
  - template: "scip-query co-change --json --full"
    when: "Inventory evidence: hidden file-level coupling from git history."
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
| `scip-query co-change --json --full` | Files that change together in git history without a dependency edge — hidden coupling candidates | Inventory evidence: hidden file-level coupling from git history. |
| `scip-query config-validate --json` | Validate .scipquery.json, including structured suppressions and declared coupling groups | Implement a slice: validate locality config after a move. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Terms

An ownership boundary is a folder, package, module, or convention that groups code around one stable responsibility.

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

### 4. Propose structure or decisions

Use this shape:

```markdown
# Directory Architecture Review

## Scope
## Current Structure Map
## Boundary Maturity
## Target Structure
## Move Ledger
## Locality Config
## No-Move Decisions
## Deferred Decisions
## Migration Order
```

List no-move decisions when broad consumers, route/package/contract surfaces, infrastructure roles, generic shared risk, or weak evidence make a move harmful.

This step is complete only when every proposed move has a reason and verification path.

### 5. Implement one slice when asked

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
```

Then invoke `scip-verify`. The implementation is complete only when imports, tests, locality signals, and verification are checked.
