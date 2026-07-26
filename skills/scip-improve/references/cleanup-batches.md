# Cleanup batches (absorbs scip-cleanup-improve)

Use when the user asks to fix cleanup findings, raise health, keep cleaning, continue after setup, or work until no safe confirmed cleanup remains. The target is not a higher health score for its own sake — it's fixing confirmed issues that make the codebase harder to understand, verify, or change.

## Before editing

If cleanup findings haven't been swept and confirmed yet, run the `scip-cleanup-audit` sweep first (or run it yourself). Then report a markdown block, before touching any code:

- current score from `scip-query health --json`
- the first confirmed batch: finding, evidence, planned fix, verification plan
- remaining signals with status

## Priority order

Work top to bottom, one item at a time:

1. Compiler-verified deletion batches (`cleanup-plan --verify`).
2. Incomplete migrations (`incomplete-migration --json --full`) and recent duplicate echoes (`duplicate-bodies --json --full`, exact small-body echoes).
3. Unused params/imports, dead symbols, isolated symbols.
4. Broken or stale docs, config validation issues, missing co-change partners.
5. Thin wrappers, passthroughs, stale abstractions, speculative generality.
6. Frontend component/hook/composable duplication and large-view pressure.
7. Directory architecture and maintainability repairs — only when evidence is strong and blast radius is bounded.

## The loop

Repeat until stopping:

1. Apply one verified deletion batch — `scip-query cleanup-apply --verified --batch <n>` against the plan from `scip-query cleanup-plan --verify --json` — or one small targeted refactor for the next prioritized item.
2. Run the narrow project check for the touched behavior (tests/typecheck scoped to what changed).
3. Run `scip-query health --json`.
4. Invoke the `scip-verify` skill.
5. If `docs/scip-query/health-dossier.md` exists (or a custom `--dossier-dir` was used), refresh it by rerunning `scip-query setup --json` with the same `--dossier-dir` if one was used.
6. Pick the next highest-priority confirmed item and repeat.

Only use `scip-query cleanup-apply --all` with explicit user approval — never apply all batches unattended by default.

## Stop when

- Only intentional, false-positive, blocked, or unconfirmed items remain.
- The next improvement would require a product/API/ownership decision.
- A missing toolchain prevents trustworthy verification.
- Further work would amount to broad redesign, not bounded cleanup.

## Between passes

After a cleanup pass, run `scip-query health --write-baseline` to snapshot finding identities. At the start of the next pass, compare against it with `scip-query health --baseline`.

## Closeout report

Starting and final health scores, batches applied, important files changed, verification commands run, remaining accepted or blocked items, and the highest-value follow-up.
