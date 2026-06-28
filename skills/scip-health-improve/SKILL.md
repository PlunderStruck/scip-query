---
name: scip-health-improve
description: Autonomously raise a scip-query repository's health score with verified, bounded cleanup. Use when the user asks to improve, raise, or maximize the health score; clean up as much as reasonable; continue after setup; pursue perfect code; or keep working with minimal interaction until no safe confirmed work remains.
---

# SCIP Health Improve

Use this skill for an autonomous health-improvement campaign. The target is not
score chasing: fix confirmed issues that make the codebase harder to understand,
verify, or change, then stop when the remaining score movement is unsafe,
unproven, blocked, or not worth the risk.

A confirmed issue is a raw scip-query signal that the agent has checked against
current code, graph evidence, or repository checks and classified as real,
intentional, false positive, or blocked.

## Non-Negotiables

1. If the environment supports durable goals and the user asked for autonomous
   health improvement, create or continue a concrete goal: raise the scip-query
   health score as high as reasonably possible by fixing confirmed actionable
   findings while preserving behavior.
2. Start from current evidence. Run setup first only if the repository has not
   been bootstrapped; otherwise refresh the index and collect current signals.
3. Before editing code, tell the user the current health score and the first
   confirmed batch you will address.
4. Do not treat raw health output as actionable until you inspect the relevant
   code, graph, or verification evidence.
5. Prioritize worst confirmed offenders first: high risk, high confidence, low
   blast radius, strong expected score movement, and clear verification path.
6. Keep working batch by batch until no safe confirmed improvement remains, the
   score stabilizes, or a real external decision blocks progress.
7. Do not run `scip-query setup-ci` in this workflow. CI setup is intentionally
   separate until that path is mature.

## Evidence Baseline

Collect the baseline before ranking:

```bash
scip-query doctor
scip-query status --capabilities
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query health --json --full
scip-query diff-gate --json
scip-query capability-matrix --json
```

Unavailable capabilities are not clean results. Record them as unproven signal
classes and fix missing local prerequisites when that is in scope.

## Priority Ladder

Work from the safest, highest-confidence improvements toward broader design
work:

1. Compiler-verified cleanup-plan deletion batches.
2. Incomplete migrations and recent duplicate echoes.
3. Unused params, unused imports, dead symbols, and isolated symbols.
4. Broken or stale docs, config validation issues, and missing co-change
   partners.
5. Thin wrappers, passthrough layers, stale abstractions, and speculative
   generality.
6. React or Vue duplicate components, hooks, composables, and large
   component/view pressure.
7. Directory architecture and maintainability repairs only when the evidence is
   strong and the blast radius is bounded.

## Confirmation Sweep

Run the relevant commands for the current repository and scope:

```bash
scip-query cleanup-plan --verify --json
scip-query recent-duplicates --json --full
scip-query incomplete-migration --json --full
scip-query unused-params --json --full
scip-query stale-abstractions --json --full
scip-query wrapper-candidates --json --full
scip-query passthrough-candidates --json --full
scip-query doc-drift --json --full
scip-query co-change --json --full
```

For frontend projects, add the relevant React or Vue maintainability commands.

Confirm candidates with targeted probes before editing:

```bash
scip-query code <symbol-or-file>
scip-query refs <symbol>
scip-query fan-in <symbol>
scip-query fan-out <symbol>
scip-query affected <symbol> --json
scip-query change-surface <file> --json --full
scip-query co-change <file> --json --full
```

## Autonomous Loop

Before the first edit, report:

```markdown
Health score: N/100

First confirmed batch:
- <finding> - <evidence> - <planned fix> - <verification>

Remaining notable signals:
- <signal> - <status: unconfirmed, intentional, false positive, blocked>
```

Then repeat:

1. Apply one verified deletion batch or one small targeted refactor.
2. Run the project check that proves the touched behavior.
3. Run:
   ```bash
   scip-query status --capabilities
   # If freshness is stale, missing, or unknown:
   # scip-query reindex
   scip-query diff-gate --json
   scip-query health --json --full
   ```
4. Fix new diff-gate findings immediately unless they are documented,
   intentional, or blocked.
5. Update `docs/scip-query/health-dossier.md` and
   `docs/scip-query/health-dossier.json` when they exist.
6. Pick the next highest-priority confirmed item.

Use `scip-query cleanup-apply --verified --batch <n>` for verified deletion
batches. Use `--all` only with explicit human approval. Use `--force-dirty`
only after inspecting the touched files and confirming existing edits are
unrelated to the cleanup batch.

## Stop Criteria

Stop the campaign when one of these is true:

- the health score stabilizes after a verified batch;
- only intentional, false-positive, blocked, or unconfirmed items remain;
- the next improvement requires a product, API, compatibility, or ownership
  decision from the user;
- a missing toolchain or unavailable capability prevents trustworthy
  verification;
- further work would be broad architectural redesign rather than bounded health
  improvement.

## Closeout

End with the starting and final health scores, batches applied, important files
changed, verification commands run, remaining accepted or blocked items, and the
next highest-value follow-up if one exists.
