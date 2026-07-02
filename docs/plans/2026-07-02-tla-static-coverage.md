# Plan 5 — TLA static-coverage upgrades (followups 13-21)

Date: 2026-07-02 · Executor: agent → Claude review. Plan-1 working agreement
applies verbatim (per-step commits `remediation P5.<n>: ...`, gates per step,
docs:commands on descriptor changes, BLOCKED notes, never git checkout/restore/stash).
Inputs: docs/plans/2026-07-02-followups.md items 13-21; specs/reindex-lock/*
(the acceptance benchmark); specs/diff-gate/*; the tla-model-system skill.

## Acceptance benchmark

`node dist/cli.js tla verify specs/reindex-lock/ReindexLock.tla --tla-tools
~/.cache/scip-query/tla2tools.jar` currently proves 7 writes / waives 11.
Done means: **waived writes ≤ 3** on this spec (via #13/#14), zero regressions
in the 694-test suite, and every item 13-21 either shipped or BLOCKED-noted.

## Steps (priority order)

- [x] **P5.1 (#13) Resource aliases.** Mapping schema: a variable may declare
  `"resource": { "path": "<expression or suffix>" }` binding it to a
  filesystem resource. Conformance write/read scans classify fs calls on a
  matching path argument (`writeFileSync`, `rmSync`, `renameSync`,
  `mkdirSync`, `unlinkSync` → write; `readFileSync`, `existsSync`,
  `statSync` → read) as effects on that variable. Path matching: the call's
  first argument text contains the declared suffix/identifier (document the
  textual basis honestly — evidence tier stays static-action). Validate in
  config-load like aliases. Update specs/reindex-lock mapping to use resources
  for lock/artifact state; delete the now-provable waivers. Tests: fixture +
  the benchmark. Update tla-model-system skill's mapping contract example.
- [x] **P5.2 (#17) Variable-referent waivers.** `variables.<v>.waive: {reason}`
  exempts `invalid-referent-kind`/`missing-referent` for that variable,
  counted in the Waivers output like action waivers. Replace the
  specs/diff-gate proxy-ref workaround with an honest variable waiver.
- [x] **P5.3 (#18) Alias collision detection.** Contract load errors when two
  variables share an alias (or a resource suffix). Test.
- [x] **P5.4 (#14) One-hop callee effects.** (waived-writes target partially met —
  see closeout report: 11→9 on the benchmark, floor is `phase`'s structural
  no-stored-field gap across all 7 actions, not a scanner limitation.) When an action's referent body
  calls another indexed function in scope, include that callee's
  write/read effects (one level only, no recursion) attributed to the
  action, marked `via: <callee>` in the finding/verified accounting. Should
  convert the preemption-path waivers on the benchmark.
- [x] **P5.5 (#20) Trace input dedup** (same path via --trace and
  contract.traces counted once) and **(#21) `--next <operator>`** on
  trace-check for dual-spec models (default `Next`). Update specs/diff-gate
  to drop the `Next == NextCurrent` alias workaround and use the flag in its
  docs example.
- [x] **P5.6 (#15) Per-action trace coverage.** trace-check output gains
  `actionCoverage`: for each mapped action, steps observed; human render
  lists unexercised actions. Test with the existing diff-gate trace.
- [x] **P5.7 (#19 + #16) Document-or-implement.** #19 implemented cleanly.
  #16 implemented AND a deeper boundary discovered/documented — see
  closeout report: the write scanner + class-field discovery algorithm
  are correct and tested, but `getDefinitionsForFile`'s primary/fallback
  merge policy (symbol-row-policy.ts) hides class-member fallback rows
  whenever the file has any primary-indexed definition, so on typical
  real classes (any with a constructor or named method) the discovery
  never sees a single field. Fixing that shared catalog primitive is out
  of scope here (repo-wide blast radius); documented in scaffold's error
  message and the skill. #19: add a mapping-level
  `unmappedWriteScope: "actions" | "scope-files"` (default current behavior)
  so per-action-range sweeps are opt-in-able; if that's >1 day, BLOCKED-note
  with rationale instead. #16 (scaffold class fields): implement class
  instance-field discovery only if the SCIP index exposes the definitions
  (agent verified it may not) — otherwise document the boundary in the
  scaffold error message + skill, BLOCKED-note the rest.
- [ ] **P5.8 Closeout.** Update followups 13-21 statuses; regenerate docs;
  benchmark Proof line in the commit message; full gates.
