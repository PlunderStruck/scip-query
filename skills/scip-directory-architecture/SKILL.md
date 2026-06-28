---
name: scip-directory-architecture
description: Review and improve repository directory architecture with scip-query evidence. Use when the user asks to design, evaluate, reorganize, or migrate source folder structure; identify feature/module ownership boundaries; turn a messy or AI-generated codebase into clearer folders; decide whether locality boundaries are mature enough for config; or plan safe directory migrations without guessing from filenames alone.
---

# SCIP Directory Architecture

## Overview

Use this skill to turn source layout questions into an evidence-backed architecture review. Do not treat the current folder tree as authoritative, and do not invent an "optimal" structure without proving the ownership concepts from code, tests, docs, and dependency evidence.

A directory architecture is the filesystem arrangement of source files by their main reason to change. Its defining trait is that a maintainer can predict where a concept belongs before reading every import.

An ownership boundary is a folder, package, module, or convention that groups code around one stable responsibility. Its defining trait is that code inside the boundary should usually change for the same kind of reason.

A target structure is a proposed future folder layout for the repo or scope. Its defining trait is that it expresses the desired ownership model, not merely a prettier tree.

A migration slice is the smallest set of file moves and import updates that can be verified independently. Its defining trait is that it reduces one structural ambiguity without requiring the whole architecture to move at once.

## Non-Negotiables

1. Start with evidence, not taste. Refresh the index when stale, then ground claims in `scip-query` outputs plus project docs and tests.
2. Separate review from migration. A directory architecture review may propose moves; it does not move files unless the user asked for implementation or approved a specific migration slice.
3. Preserve working conventions. Existing boundaries are not wrong just because they are broad; central folders such as `errors`, `routes`, `workflows`, `schemas`, `contracts`, or `features` may be doing real work.
4. Do not reward generic `shared`. A shared folder is justified only when the shared concept has a name, owner, and consumers across real boundaries.
5. Treat messy repos honestly. If ownership concepts are not stable, produce a discovery map and decision list instead of pretending the repo has a clean target structure.
6. Prefer small verified moves. Broad reorganizations need staged migration slices with import updates, tests, a fresh scip-query index, and `scip-query diff-gate --json`.

## Workflow

### 1. Bound the Question

Identify whether the user wants:

- a review of the existing structure;
- a proposed target structure;
- a locality config decision;
- a migration plan;
- or an actual file-moving implementation.

If the user asks for "the best folder structure," translate that into: "What ownership model is supported by this repo's code, tests, product domains, and change history?"

### 2. Refresh and Inventory

Run:

```bash
scip-query status
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query stats
find . -maxdepth 3 -type d | sort
```

Read durable project guidance before judging structure:

```bash
rg -n "architecture|structure|feature|module|boundary|shared|workflow|route|contract|domain|ownership" AGENTS.md README.md docs agent-os .codex -g '!node_modules'
```

Use `rg --files` to sample real files in each important folder. Ignore generated, build, coverage, vendored, and dependency directories unless they are part of the architecture question.

### 3. Build the Evidence Map

Use these probes as evidence, not as verdicts:

```bash
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

For each folder under review, record:

- real-world concept or product area represented by the folder;
- public exports, entry points, routes, commands, or package surfaces;
- main consumers and cross-boundary consumers;
- tests that define the folder's behavior;
- co-change partners and repeated edit patterns;
- duplicated or parallel folder patterns;
- docs or standards that claim ownership rules.

### 4. Classify Boundary Maturity

Classify each candidate folder:

- Mature: repeated, documented, and enforced by imports, tests, routes, packages, standards, or review history.
- Emerging: meaningful and partly repeated, but not yet consistent enough to configure or enforce.
- Accidental: a convenience bucket, legacy pile, generated artifact, recent edit cluster, or mixed folder with unrelated reasons to change.

A slop codebase is a codebase whose files are arranged by accident, convenience, or recent edits rather than stable ownership rules. Its defining trait is that directory names do not reliably predict where code should live. For this case, stop at discovery and decision prompts unless the user explicitly asks for a first migration slice.

### 5. Propose the Target Structure

Produce an architecture proposal with this shape:

````markdown
# Directory Architecture Review

## Scope
## Current Structure Map
## Boundary Maturity

| Boundary | Evidence | Maturity | Judgment |
| --- | --- | --- | --- |

## Target Structure

```text
src/
  ...
```

## Move Ledger

| Slice | Current files | Proposed home | Why | Verification |
| --- | --- | --- | --- | --- |

## Locality Config
## Deferred Decisions
## Migration Order
````

The target structure should name ownership concepts, not just folder labels. Prefer existing names when they already carry meaning. Introduce a new folder only when it removes ambiguity for multiple files or consumers.

### 6. Decide What Not to Move

Explicitly list no-move decisions when:

- a broad consumer set proves a central boundary is useful;
- a folder is route-facing, package-facing, or contract-facing;
- consumers cross boundaries because the concept is infrastructure;
- moving would hide a domain-specific concept under generic `shared`;
- the evidence is too weak and needs a human ownership decision.

### 7. Implement Only a Migration Slice

When the user asks to proceed, pick the smallest high-confidence slice. Before editing, state:

- files to move;
- imports/exports/tests/docs to update;
- expected verification commands;
- rollback risk.

Then move files with normal filesystem tools, update imports with project tooling where available, and run:

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query incomplete-migration
scip-query recent-duplicates
scip-query co-change <moved-file-or-config>
scip-query diff-gate --json
```

Also run the repo's normal tests or typecheck for the affected workspace. If the migration adds or changes `.scipquery.json` locality settings, run:

```bash
scip-query config-validate
scip-query locality-candidates --json --full
```

## Output Rules

- Lead with findings and judgments, not command transcripts.
- Every proposed boundary needs evidence from at least two independent signals or a clear note that it is only a candidate.
- Every proposed move needs a verification path.
- For messy repos, output "discovery mode" and decision questions instead of a fake complete architecture.
- For implementation, never batch unrelated folder moves just because they fit the same target structure.
