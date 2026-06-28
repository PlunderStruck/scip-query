---
name: scip-health-audit
description: Confirm and prioritize scip-query health signals before cleanup. Use after `scip-query setup`, when reviewing `docs/scip-query/health-dossier.*`, when a user asks for a health audit, issue cleanup, perfect-code pass, setup follow-through, or confirmation of raw scip-query findings before an agent starts fixing them.
---

# SCIP Health Audit

Use this skill to turn raw scip-query health output into a confirmed cleanup queue.

A health signal is a scip-query reported fact about source code, references, docs, or capability coverage that may indicate maintenance risk. A confirmed issue is a health signal the agent has checked against the current code and SCIP evidence, then classified as a real fix target, an intentional design choice, a false positive, or a blocked investigation.

For autonomous score improvement after this confirmation pass, invoke
`scip-health-improve`. This skill is the confirmation and ranking pass; the
improvement skill owns the keep-working cleanup loop.

## Non-Negotiables

1. Start from current evidence. Run `scip-query reindex` when the index is stale, missing, or uncertain.
2. Do not start cleanup before telling the user the health score and listing the confirmed items that need attention.
3. Do not call raw analyzer output an issue until you inspect the code or graph evidence that makes it real.
4. Do not defer confirmed fix targets into vague future work. If the active user request asks for cleanup, start the safest confirmed batch after the visible health report.
5. Do not use `scip-query setup-ci` in this workflow. CI setup is intentionally outside first-run setup and health cleanup for now.

## Evidence Collection

If setup just ran, read the dossier first:

```bash
scip-query setup --json
```

Then collect the current state:

```bash
scip-query doctor
scip-query status --capabilities
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query health --json --full
scip-query diff-gate --json
scip-query capability-matrix --json
scip-query config-validate --json
```

If `doctor`, `status`, or `capability-matrix` reports unavailable capabilities, record them as unavailable checks. Unavailable is not clean; it means this signal class was not proven in this repository.

## Signal Sweep

Run the relevant commands for the repository and scope. Prefer `--json` where supported so the dossier can be updated without scraping prose.

```bash
scip-query cleanup-plan --verify --json
scip-query recent-duplicates --json --full
scip-query incomplete-migration --json --full
scip-query unused-params --json --full
scip-query stale-abstractions --json --full
scip-query wrapper-candidates --json --full
scip-query passthrough-candidates --json --full
scip-query dead --json --full
scip-query isolated --json --full
scip-query cycles
scip-query co-change --json --full
scip-query doc-drift --json --full
```

For React projects, add:

```bash
scip-query react-component-duplicates --json --full
scip-query react-hook-candidates --json --full
scip-query react-large-component-pressure --json --full
```

For Vue projects, add:

```bash
scip-query vue-component-duplicates --json --full
scip-query vue-composable-candidates --json --full
scip-query vue-large-view-pressure --json --full
```

## Confirm Findings

For every candidate that could become a fix target, inspect the relevant code and graph evidence.

Use these probes as needed:

```bash
scip-query code <symbol-or-file>
scip-query refs <symbol>
scip-query fan-in <symbol>
scip-query fan-out <symbol>
scip-query affected <symbol> --json
scip-query change-surface <file> --json --full
scip-query convergence <symbolA> <symbolB>
scip-query co-change <file> --json --full
```

Classify each candidate:

- `confirmed fix target`: the code evidence shows unnecessary code, broken migration, stale docs, accidental duplication, hidden coupling, or another real maintenance burden.
- `intentional design`: the finding is real but the current shape exists for a documented product, compatibility, performance, API, or ownership reason.
- `false positive`: the analyzer report contradicts inspected code or graph evidence. Record the analyzer improvement needed.
- `blocked`: confirmation needs a missing toolchain, missing test command, missing product decision, or unavailable capability.

Use `scip-query suppress <id> --reason "<specific reason>"` only for accepted findings that have stable finding IDs and a durable reason. A suppression is an explicit design record, not a way to hide uncertainty.

## User Handoff Before Cleanup

Before editing application code, send the user a compact report in this order:

```markdown
Health score: N/100

Confirmed items to address:
- [priority] <finding> - <evidence command> - <first safe action>

Unconfirmed signals:
- <signal> - <what evidence is still needed>

Unavailable or blocked checks:
- <check> - <why it could not be proven>

Recommended first cleanup batch:
- <batch> - <why this is safe to start now>
```

If there are no confirmed fix targets, say that clearly and list remaining unconfirmed or unavailable signals.

## Cleanup Order

When the user has asked for cleanup or the current workflow is post-setup cleanup, start after the handoff with the safest confirmed batch:

1. Compiler-verified deletion batches from `scip-query cleanup-plan --verify --json`, applied with `scip-query cleanup-apply --verified --batch <n>`.
2. Broken or stale docs from `scip-query doc-drift --json --full`.
3. Incomplete migrations and recent duplicate echoes from `scip-query incomplete-migration --json --full` and `scip-query recent-duplicates --json --full`.
4. Unused trailing parameters from `scip-query unused-params --json --full`.
5. Thin wrappers, passthroughs, stale abstractions, and hidden co-change couplings after confirming behavior.

After every batch:

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query diff-gate --json
scip-query health --json --full
```

Update `docs/scip-query/health-dossier.md` and `docs/scip-query/health-dossier.json` when they exist. Preserve raw signals, confirmation status, evidence commands, fixes applied, and remaining blockers.

## Finish Criteria

The audit is complete only when every collected signal is one of:

- fixed and verified;
- confirmed intentional with a durable reason;
- recorded as a false positive with analyzer-improvement notes;
- blocked by a named external constraint or user decision.

End with the final health score, the verification commands run, and the remaining blocked or intentionally accepted items.
