# Graph follow-up and VM installation

Status: installation and bounded accuracy assessment complete. The additional findings below remain open; no new production repair was included in this installation.

The user requested installing the validated incoming-call repair on the VM through `ssh dev-agent`, and assessing further graph inaccuracies. Preserve the existing working-tree repairs and unrelated benchmark document. Do not restart watchers that were stopped by the user.

## Installation

- [x] Package the validated working-tree build and skills. Archive SHA-256: `0277db1ab62a8b69d742a185df2555e0709f273658db0f28842cc6e6a34aaf4c`; 459 package files, including 19 skill files. Package version remains 0.25.0.
- [x] Confirm the SSH user is `launchpoint-agent` (UID 1002), with global prefix `/home/launchpoint-agent/.local`. The login profile resolves one `scip-query` executable to the canonical package there.
- [x] Snapshot actual live watcher processes, rather than selecting cached records: PID 2262397 for `.t3/worktrees/launchpoint-backend/t3code-b92f0666`, PID 2547797 for `projects/launchpoint-next-read-latency`.
- [x] Verify staged package and existing Linux dependency compatibility; recheck process identity before stopping only the live selected watchers; replace the canonical package with rollback retained outside PATH.
- [x] Update and verify the six workflow skill links and installed file hashes.
- [x] Exercise the installed CLI on an isolated real-index fixture, including aliases, false-call counterexamples and Unicode coordinates.
- [x] Rebuild active checkout indexes for producer contract 3, restart only selected watchers stopped for this installation, and verify status and installed process identities.

The canonical package is `/home/launchpoint-agent/.local/lib/node_modules/scip-query`. Dependency and optional-dependency declarations matched the prior installation exactly; retained its Linux native modules. Verified all 459 package hashes and 12 links to the six skills in Codex and Claude. The rollback package is outside PATH at `/tmp/scip-query-incoming-install-20260908/previous-package`.

The installed CLI passed eight independently enumerated direct-call cases, excluded the shadowing counterexample, and resolved tagged-template and Unicode cases using a real compiler index with watching disabled. New watcher PIDs are 2636886 (b92f0666) and 2636982 (next-read-latency). Each process was verified against its checkout and the canonical installed script. No stopped worktree was restarted.

Both active checkout indexes were fresh at the final migration check (2026-09-09 01:26:58–59 UTC). Next-read-latency's compatible rebuild completed in 177.5 seconds. Another agent's manual reindex already held b92f0666's lifecycle lock; this installation's competing attempt correctly failed without overriding it. That existing run completed the rebuild in 200.3 seconds, and the resulting index was fresh.

Both saved TypeScript fingerprints declare producer contract 3. All 8,901 documents in b92f0666 and all 8,892 in next-read-latency declare UTF-16 coordinates. The compact receipt is `producer-verification.json` in the VM artifact directory.

Both watchers were already paused by their configured automatic-write budget before installation. They are still running with that budget policy intact; a fresh manual rebuild does not mean automatic refresh is presently unpaused. No budget was raised or history cleared. The snapshot and final status exports preserve this operational limitation.

Operational artifacts are saved locally and on the VM under `/tmp/scip-query-incoming-install-20260908/`.

## Further graph accuracy assessment

- [x] Select concrete supported relationship claims and independently expected outcomes; use real compiler/CLI fixtures rather than comparing two graph commands as the sole oracle.
- [x] Check untested call forms and source ownership boundaries, then assess whether graph output discloses unresolved relationships accurately.
- [x] Record confirmed defects separately from documented static-analysis limitations. Any additional repair needs a failing regression, a reused implementation path, and focused plus required validation.

The preceding repair passed all 3,445 tests, lint, type checking, and configured architecture checks. This follow-up is a bounded investigation, not proof that every language, graph family or dynamic execution is completely represented.

## Open finding 1: exact source owners are lost when constructs share lines

A source construct is a particular function, statement, or other syntax unit in a file. Its position includes columns as well as lines: two different functions can occupy the same line. The graph still discards this distinction in downstream normalization and control analysis, even though the repaired compiler call resolver retains the nearest function's full source coordinates.

The real public CLI reproduced three incorrect exact relationships:

```ts
export function outer() { function inner() { return target(); } return inner; }
export function first() { return 1; } export function second() { return 2; }
export const unusedArrow = () => 0; export const activeArrow = () => target();
```

- Incoming execution for `target` labels the nested caller as the source construct `outer`, and the arrow caller as `unusedArrow`.
- Outgoing execution from the exact compiler symbol `outer()` attaches the terminal `return target();`, which belongs to `inner`.
- Outgoing execution from the exact compiler symbol `second()` reports `[exact] calls:second() -> return 1; — returns`. This contradicts the selected function's body. The packet says the selected construct contains that terminal, with `accounted` coverage and zero unsupported frontiers.
- The fixture passes TypeScript checking and executes with `first() === 1`, `second() === 2`, `unusedArrow() === 0`, `activeArrow() === 7`, and `typeof outer() === 'function'`. This supplies a source and runtime counterexample independent of either graph direction.

Confirmed live causes:

- `src/queries/graph/system-map.ts`, `canonicalSourceConstruct` (line 2603), reselects the smallest callable by start line and can replace an already identified inner/arrow owner with a different callable sharing those lines.
- `sourceConstructIdentity` and `sourceConstructKey` retain file, lines, and name but omit columns. `prepareFileTraversal` compares source constructs to parsed owners by lines alone.
- `src/queries/graph/program-control-edges.ts:29` passes only the owner's line range to `behaviorControlAnalysis`.
- `src/source/facts/behavior-skeleton.ts:1176`, `findCallableNode`, descends through covering children and chooses a callable by line overlap without the selected compiler identity. It can analyze the sibling or nested function instead.

Priority: repair this first because the output asserts the wrong behavior as exact. Carry declaration identity/full source coordinates through the existing source-construct path and control-analysis lookup; preserve unresolved/ambiguous status when an owner cannot be identified uniquely. Do not merely rename the misleading result or weaken every relationship to candidate. Cover adjacent declarations, nested declarations, arrows, multiple anonymous callbacks, and distinct control/return statements with independently expected public-CLI regressions.

## Open finding 2: an explicit superclass constructor call is omitted

```ts
export class Box { constructor() { target(); } }
export class Child extends Box { constructor() { super(); } }
export function create() { return new Box(); }
```

Selecting the exact `Box#<constructor>()` compiler symbol yields the `create -> Box constructor` call, but no `Child constructor -> Box constructor` call. Selecting the exact Child constructor with outgoing execution yields no edges. Both queries used depth 1, full output, and an ample edge budget. The packets show no specific unsupported frontier for `super()`.

The constructor's compiler `refs --full` output also contains only the `new Box()` reference. This is therefore a missing superclass-invocation support/coverage case, not another case of the incoming traversal dropping an existing constructor reference. Selecting the class's source line instead of its constructor is a separate selector choice and is not counted as a defect.

Priority: after source ownership, assess shared constructor-call resolution from exact class inheritance evidence and report a recoverable unsupported relationship when resolution cannot be established. Include aliased/re-exported bases, generic bases, implicit constructors, ambiguous base expressions, and `super.method()` as distinct cases; this fixture establishes only the explicit `super()` omission.

## Audit artifacts and passed counterchecks

Local artifacts: `/tmp/scip-query-graph-followup-20260908/`. `audit.py` creates the initial fixture and exports bounded public graph results to files. The repository's appended `first/second` and `unusedArrow/activeArrow` cases are preserved in `repo/calls.ts`; `second-outgoing.json`, `second-human.log`, and `arrow-incoming.json` record the additional counterexamples. `exact-constructor.json`, `constructor-refs.json`, and `child-outgoing.json` isolate constructor identity and provider coverage.

`confirmed-findings.json` records successful assertions that the incorrect graph results reproduce, together with the independently executed runtime counterchecks. These are defect reproductions, not passing production regressions claiming the defects are fixed.

Ordinary direct calls, parentheses, TypeScript assertions, `satisfies`, non-null assertions, parameter-default calls, renamed imports after emoji, and tagged templates resolved in the initial fixture. Passed function values and shadowed parameters did not become calls to the unrelated imported target. Arbitrary indirect calls, dynamic dispatch, and unrelated relationship families were not established as complete by these checks.
