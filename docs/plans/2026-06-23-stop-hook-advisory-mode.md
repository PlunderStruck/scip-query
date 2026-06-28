# Stop Hook Advisory Mode

## Goal

Make installed `scip-query hook-stop` useful without trapping Claude Code in a
finish-blocking loop over diff-gate findings that can be false positives,
intentional design choices, or unrelated baseline drift.

## Evidence

- `scip-query plan-context src/runtime/agent-hooks.ts --full` shows
  `src/runtime/agent-hooks.ts` owns hook installation and the hidden
  `hook-stop` handler, with consumers in command descriptors, command handlers,
  and setup.
- `scip-query code handleAgentHookStop` shows the previous behavior: run
  `diffGate()` and set `process.exitCode = 2` whenever findings exist.
- `scip-query code scipHookGroup` shows installed Stop hooks call
  `scip-query hook-stop`.
- Claude Code hook docs say exit code 2 on `Stop` prevents Claude from
  stopping, while `systemMessage` warns the user and
  `hookSpecificOutput.additionalContext` gives non-error Stop feedback.

## Plan

- In `src/runtime/agent-hooks.ts`, keep running `diffGate()` from
  `handleAgentHookStop`, but emit structured hook JSON instead of setting exit
  code 2 by default.
- Add `SCIP_QUERY_STOP_HOOK_MODE`:
  - default / unknown value: `warn`, return `systemMessage` and allow stop;
  - `feedback`: return Stop `additionalContext`, so Claude continues without a
    hook error;
  - `block`, `blocking`, `1`, `true`, `yes`: return `decision: "block"`.
- Keep the existing block message for explicit blocking, but soften default
  advisory text to “review when relevant.”
- Cover all three modes in `tests/runtime/agent-hooks.test.ts`.
- Update public docs so users understand the default is advisory and enforcement
  is opt-in.

## Verification

- `npx vitest run tests/runtime/agent-hooks.test.ts tests/runtime/setup.test.ts`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `scip-query reindex`
- `scip-query diff-gate --json`
