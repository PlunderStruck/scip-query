---
name: scip-doc-reconcile
description: Reconcile standards docs and living documentation with the current code using scip-query doc-drift evidence. Updates descriptive claims, repairs broken file references, and escalates normative violations instead of silently blessing them. Ends with staleness driven to zero.
---

# Doc Reconciliation with scip-query

Standards docs exist so agents implement consistently. When the code moves and
the doc doesn't, every agent that reads it implements against a dead spec.
This skill reconciles docs with reality — using evidence, not memory.

## The One Rule That Matters

A doc contains two kinds of statements, and they drift differently:

- **Descriptive** ("the horses workflow lives in `workflows/horses.ts` and
  exposes `listHorses`") — when code moved on, **update the doc**.
- **Normative** ("all routes MUST validate stable scope before querying") —
  when code violates it, **do NOT rewrite the standard to bless the
  violation**. Either fix the code to comply, or record the contradiction in
  the report for a human decision. Silently weakening a standard to match
  drifted code is worse than the drift.

When unsure which kind a statement is: MUST/SHOULD/NEVER language is
normative; file paths, symbol names, and behavior descriptions are
descriptive.

## Workflow

### 1. Build the evidence-backed worklist

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query doc-drift                      # all living docs, ranked by staleness
scip-query doc-drift agent-os/standards   # scoped to a standards tree
```

Triage order:
1. Docs with `BROKEN REFERENCE` lines (the spec cites deleted code — actively wrong)
2. Highest staleness score
3. Docs agents read most (AGENTS.md, CLAUDE.md, standards indexes)

Track each doc as a task. Archival docs (dated plans, ADRs, reports) are
excluded automatically — do not "reconcile" records of past decisions.

### 2. Reconcile one doc at a time

For each doc, gather what actually changed:

```bash
scip-query doc-drift <doc>                            # its subjects + changes since
git log --oneline -15 -- <subject-file>               # WHY the subject changed
scip-query outline <subject-file>                     # what it looks like NOW
scip-query system <module>                            # current module shape
scip-query trace <symbol-the-doc-mentions>            # does it still exist? who uses it?
```

Then edit the doc:

- **Broken references**: find where the code went (`scip-query files <stem>`,
  `git log --follow`) and update the citation — or delete the claim if the
  capability is gone.
- **Stale descriptive claims**: re-read the subject files and rewrite the
  claims to match current behavior. Every concrete claim you write must be
  something you verified with a scip-query command this session — no claims
  from memory.
- **Examples and snippets**: re-derive them from current code
  (`scip-query code <symbol>`), don't patch them by eye.
- **Normative violations found while reading**: add them to the report under
  "Standard vs code contradictions" with file:line evidence. Do not edit the
  normative text.

### 3. Verify, per doc and overall

```bash
scip-query doc-drift <doc>     # staleness must drop to 0, broken refs to none
scip-query diff-gate --json    # your own doc edits gate clean before commit
```

A doc still showing staleness after your edit means a subject changed in
ways you haven't reflected — go back.

### 4. Report

- Per doc: staleness before → after, broken references fixed, claims updated.
- **Standard vs code contradictions** (normative): each with the standard's
  requirement, the violating file:line, and a recommendation (fix code /
  amend standard) — explicitly awaiting a human call.
- Docs recommended for deletion (describe removed capabilities entirely).

## Hard Rules

1. Every updated claim cites the scip-query command that verified it (in the
   commit message or PR description).
2. Never weaken normative language to match drifted code.
3. Never reconcile archival docs (plans, ADRs, reports) — they are records.
4. One commit per doc (or tight group) so review is per-standard.
5. Re-run `scip-query doc-drift` at the end; the summary line is the result.
