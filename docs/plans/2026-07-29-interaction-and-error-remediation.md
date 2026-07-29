# Interaction-and-error remediation program

Date: 2026-07-29  
Status: approved for implementation by the user  
Source review: `docs/reviews/2026-07-29-interaction-and-error-audit.md`

## Goal

Make every mutating or evidence-completion command in the audit perform the
scope its visible invocation selects, reject option combinations whose meaning
would be ignored, expose consequential targets before mutation, and render a
result from observed state rather than a categorical success string.

Done means:

- every finding IE-01 through IE-12 has a focused regression test;
- the pre-registered focused baseline grows from 147 passing tests without
  losing an existing test;
- no bare command can remove both global and project integrations;
- no accepted option is silently ignored by the active command mode;
- partial index state and transport-only completion are explicit;
- every generated command document and affected skill example is current;
- the full repository test, typecheck, lint, build, public-API, diff-impact,
  and diff-gate checks pass, or a remaining detector result has an explicit
  evidence-backed disposition.

## Definitions and invariants

An **interaction decision** is the pure classification that maps parsed CLI
options and observable runtime state to one allowed action or one actionable
refusal. Its concrete inputs are booleans such as `guided`, `yes`, `remove`,
and `force`, stream interactivity, and watcher classification. Its defining
property is that no filesystem, process, or global mutation occurs until the
classification succeeds.

A **mutation preview** is a command result computed from the same current plan
and safety checks as a real mutation, distinguished by stopping before the
side-effect boundary. It is not a stale example or documentation listing:
the selected targets and verification result must come from the invocation
that prints them.

A **side-effect boundary** is the point where a deterministic command decision
becomes an external state change. The referents here are removing symlinks,
rewriting hooks and managed Markdown blocks, starting or stopping a process,
publishing an index generation, writing a suppression file, deleting source
ranges, and writing an output snapshot.

A **derived verdict** is a final human message selected from actual result
fields rather than from the command path that was attempted. `written`,
`unchanged`, `skipped`, `removed`, and `skipped languages` are the facts from
which the relevant verdicts must be formed.

The program preserves these invariants:

- **I1 — Explicit destructive scope:** a real uninstall removes global or
  project integrations iff that scope was explicitly selected.
- **I2 — Preview purity:** a dry run performs no externally visible mutation
  while reporting the targets the corresponding real invocation would
  change.
- **I3 — Mode honesty:** every accepted option affects the active operation;
  otherwise the invocation fails before side effects.
- **I4 — Result honesty:** a success verdict is emitted iff the result fields
  establish that success; skipped or partial work remains visible.
- **I5 — Evidence-layer separation:** transport completion never implies
  complete command coverage.
- **I6 — Compatibility:** existing structured JSON fields, cursor encoding,
  command names, and successful explicit invocations remain readable and
  callable; new flags and human wording are compatible extensions.
- **I7 — User-owned content:** no repair broadens ownership beyond existing
  scip-query-managed links, blocks, hooks, snapshots, or verified cleanup
  targets.

## Premises

**P1.** Public command names, options, help, agent contracts, and generated
command documentation are owned by command descriptors.

Source: `src/runtime/commands/command-descriptors.ts`,
`src/runtime/query-commands/cleanup/descriptors.ts`,
`src/runtime/command-kit/command-docs.ts`.

**P2.** `runUninstall` currently maps absent scope to both global and project,
while `handleUninstall` is the single CLI consumer.

Source: `src/runtime/uninstall.ts:19-42`; `scip-query refs runUninstall --full`
returned only `src/runtime/commands/command-handlers.ts`.

**P3.** Project-hook removal uses no command prefix, but
`installProjectAgentHooks` currently resolves the prefix before entering its
removal branch.

Source: `src/runtime/agent-hooks.ts:220-260`; runtime failure from
`scip-query uninstall --dry-run`.

**P4.** Guided setup selection is controlled by stdin/stdout TTY state inside
`guidedProjectSetupOptions`, independently of the `--guided`, `--yes`, and
`--json` combination chosen by the handler.

Source: `src/runtime/commands/command-handlers.ts:1300-1414`.

**P5.** Watch timing overrides are consumed only when a foreground watcher or
new daemon is created. `ensureWatchService` returns a live service before
using the overrides, and status/stop do not apply them.

Source: `src/runtime/commands/command-handlers.ts:1513-1662`;
`src/runtime/watch-service.ts:276-346`; `scip-query trace ensureWatchService`.

**P6.** `ReindexResult.skipped` is the complete list of languages not included
in a permitted partial publication, and published metadata derives
`status: 'partial'` from the same list.

Source: `src/reindex/index.ts:167-187` and `1540-1585`.

**P7.** Configuration initialization already uses revision-aware mutation and
knows whether the committed write changed the file, but its public wrapper
discards that fact.

Source: `src/runtime/config.ts:731-748`;
`src/runtime/revisioned-file.ts`.

**P8.** Agent setup and hook setup return complete result arrays for written,
updated, unchanged, removed, and skipped targets.

Source: `src/runtime/agent-setup.ts:90-113`;
`src/runtime/agent-hooks.ts:220-260`.

**P9.** Suppression creation already has the effective option scope, expiry,
reason code, and evidence list at the handler boundary; no new persisted field
is needed to render them.

Source: `src/runtime/commands/command-handlers.ts:1078-1127`;
`src/runtime/suppression-writer.ts`.

**P10.** Cleanup selection and verification are computed before
`applyCleanupBatches`; therefore a dry-run can reuse the exact current plan,
selection, dirty-worktree inspection, and verifier without creating a second
planner.

Source: `src/runtime/query-commands/cleanup/handlers.ts:902-953`;
`src/runtime/cleanup-verify.ts:84-570`.

**P11.** JSON pagination already distinguishes transport completion from
command coverage, while only the human footer loses that distinction.

Source: `src/runtime/output-pagination.ts:392-429` and `1367-1375`.

**P12.** Production references for the changed handlers are their registered
command descriptors; `runWithCliOutputPagination` is consumed by command
registration; `initProjectConfig` additionally crosses the package runtime
export.

Source: complete `scip-query refs --full` runs for `handleReindex`,
`handleSetupAgent`, `handleSetupHooks`, `handleWatch`, `handleSuppress`,
`initProjectConfig`, `runUninstall`, `runWithCliOutputPagination`, and
`handleCleanupApply`.

**P13.** The focused pre-change test baseline is 8 files and 147 passing
tests. Restricted-cache failures disappear when the same test command has
access to the normal scip-query cache.

Source: observed `pnpm vitest run` baseline on 2026-07-29.

## State-authority inventory

| State | Authoritative writer | Readers | Transition rule |
| --- | --- | --- | --- |
| User-global skill links | `installSkills` / `uninstallSkills` | agent runtimes, setup status | remove only links resolving inside the shipped skill root |
| Project hook configuration | `installProjectAgentHooks` | Codex/Claude runtimes | mutate only untracked local configs and owned hook entries |
| Hook opt-out | project Claude settings tombstone | later hook setup | removal records decline; force is required to reverse it |
| Managed agent guidance | `setupAgent` / `removeAgentSetup` | agents loading AGENTS/CLAUDE files | mutate only the marked block |
| Watcher process timing | newly started foreground/daemon watcher | watch loop and status | an override is effective only in the process created with it |
| Current index completeness | reindex publication metadata | status and all queries | skipped requested languages imply partial evidence |
| Project config initialization | revision-aware config writer | every command context | existing bytes remain authoritative and unchanged |
| Suppression decision | one revisioned suppression record | diff-gate/effectiveness | exact finding identity plus adjudicated evidence and optional expiry |
| Cleanup-selected source | `applyCleanupBatches` | Git, compiler, user | only the currently planned and verified batch may be deleted |
| Output snapshot | pagination writer | cursor continuation/session state | immutable ordered pages; transport completion is byte retrieval only |

## Current flow

Command descriptors register handlers and generate help/docs (P1). Handlers
parse commander options, resolve project state, then cross one or more
side-effect boundaries. Several handlers currently validate after too much
interpretation or omit a mode-specific check:

1. uninstall delegates absent scope to a core default that selects both (P2);
2. hook removal resolves installation identity before its early return (P3);
3. setup decides whether to prompt inside the guided implementation rather
   than validating the requested interaction mode at entry (P4);
4. watch constructs overrides for every lifecycle mode, while only new process
   creation consumes them (P5);
5. reindex, setup-agent, init, suppress, cleanup, and pagination possess the
   facts needed for precise results but render summaries that omit or
   contradict those facts (P6-P11).

## Affected consumers

| Surface | Kind | Consumer | Disposition |
| --- | --- | --- | --- |
| `uninstall` options/default | CLI/external | humans, agents, scripts | compatible safety tightening: real no-scope invocation now refuses |
| `runUninstall` | direct | `handleUninstall` | unchanged core compatibility; guard remains at CLI boundary |
| hook removal branch | direct | setup-hooks and project uninstall | both gain identity-independent removal |
| setup options | CLI/external | terminal users, JSON callers, agents | conflicting or impossible guided forms now refuse with alternatives |
| watch timing options | CLI/external | watcher operators and agents | ignored combinations refuse; ordinary reuse stays unchanged |
| reindex human result | CLI/external | humans and agents | additive warning only when `skipped` is nonempty |
| init result | package/runtime | existing importers of `initProjectConfig` | old string-returning export preserved; handler uses additive detailed helper |
| setup-agent human result | CLI/external | humans and agents | derived summary; result structure unchanged |
| suppression human result | CLI/external | humans and agents | additive detail; JSON structure unchanged |
| cleanup-apply options/result | CLI/external | humans, agents, generated docs/skills | additive `--dry-run`, exact target feedback |
| human page footer | CLI/external | agent readers | wording-only clarification; cursor and JSON schemas unchanged |
| descriptors | docs/tests | command reference, CLI contract tests | regenerate and update expectations |

Non-indexed consumers to check with literal search:

- README and `docs/COMMAND_REFERENCE.md`;
- generated AgentContract catalog;
- setup and verify skills;
- command examples in plans/reviews;
- shell scripts invoking the affected modes;
- CLI snapshot/contract tests.

## Reuse decisions

- Reuse the existing handler option decoding and descriptor option builders;
  do not create a second CLI framework.
- Reuse hook removal's existing `dryRun` support; expose and render it rather
  than implementing a parallel preview.
- Reuse `inspectWatchService` and its `live` classification; do not persist a
  second watcher configuration record.
- Reuse `ReindexResult.skipped`; do not add a redundant `status` field to the
  public result merely for human rendering.
- Preserve `initProjectConfig` as a compatibility wrapper and expose one
  internal detailed result from the same revision-aware mutation.
- Reuse setup/suppression result fields for derived messages.
- Reuse `cleanupPlan`, `selectCleanupBatches`, `verifyCleanupPlan`, and
  `cleanupVerificationFailures` for preview and apply. There must be one
  selection pipeline with mutation as the final optional step.
- Reuse the existing page envelope's semantic wording in the human footer.

No new persistent schema, daemon protocol field, config option, cursor version,
or suppression field is justified.

## Testability design

Pure entry-mode validation will be expressed as small functions taking parsed
booleans and observable state. Handlers remain thin side-effect shells:

- setup validation takes `guided`, `yes`, `json`, `stdinTTY`, `stdoutTTY`;
- hook validation takes `remove`, `force`, `dryRun`;
- uninstall validation takes `global`, `project`, `dryRun`;
- watch validation takes lifecycle mode, supplied timing keys, and live-service
  state;
- render helpers take existing result objects and return lines.

Filesystem behaviors use real temporary directories and real revision-aware
writers. Watch process behavior uses the existing last-adapter runtime seam.
Reindex handler tests substitute the reindex boundary but assert only emitted
CLI output. Cleanup tests use a real temporary Git repository and checker,
not a mock deletion planner.

## Implementation slices

### Slice 1 — IE-02: make project-hook removal identity-independent

**Files:** `src/runtime/agent-hooks.ts`,
`tests/runtime/agent-hooks-locality.test.ts`, `tests/runtime/uninstall.test.ts`.

**Change:** enter and finish the removal branch before resolving
`projectHookCommandPrefix`.

**Validation:** a prefix resolver that would fail is never reached by dry-run
or real removal; focused hook/uninstall tests pass.

**Deployable:** yes. Installation behavior remains unchanged.

### Slice 2 — IE-01: require explicit real uninstall scope

**Files:** command handler/descriptors, uninstall tests, command docs.

**Change:** refuse no-scope real removal; retain no-scope dry-run of both.

**Validation:** four scope combinations prove I1.

**Deployable:** yes. This is an intentional safety tightening; explicit
existing invocations are unchanged.

### Slice 3 — IE-03: compress retained uninstall output

**Files:** command handler/descriptors, CLI contract and uninstall tests,
generated docs.

**Change:** summarize `left` by count by default; add `--verbose` for the full
list; preserve JSON.

**Validation:** default output contains changed targets and one retained count,
verbose contains identities, JSON contains the complete array.

**Deployable:** yes; compatible additive flag.

### Slice 4 — IE-04: make guided setup a real mode

**Files:** command handler, project-setup/interaction tests, command docs.

**Change:** reject guided/non-TTY, guided/yes, and guided/json before state
inspection.

**Validation:** every invalid form proves `runProjectSetup` and prompt logic
were not reached; terminal guided and noninteractive `--yes` remain green.

**Deployable:** yes; impossible or contradictory forms fail explicitly.

### Slice 5 — IE-05: preview and disambiguate hook removal

**Files:** command handler/descriptors, hook tests, command docs.

**Change:** expose `--dry-run` for `--remove`, reject conflicting modes, and
render removal-specific summaries.

**Validation:** dry run leaves bytes unchanged and names would-remove targets;
real removal changes only managed entries and records the opt-out.

**Deployable:** yes; compatible additive preview.

### Slice 6 — IE-06: reject ignored watch timing

**Files:** command handler, watcher/runtime-config tests, command docs.

**Change:** reject timing in status/stop; reject daemon overrides when a live
service would be reused; name exact recovery and process-local semantics.

**Validation:** ignored combinations fail before stop/status/ensure effects;
ordinary daemon reuse and new daemon overrides still work.

**Deployable:** yes. It prevents false success without restarting a process.

### Slice 7 — IE-07: disclose partial reindex publication

**Files:** command handler, reindex JSON/human tests, README/command docs if
they describe partial mode.

**Change:** derive a human warning and per-language reasons from `skipped`.

**Validation:** complete/reused output remains stable; partial fixture prints
warning, names every skipped language, and states the evidence limit; JSON is
unchanged.

**Deployable:** yes; additive feedback.

### Slice 8 — IE-08: render committed init outcome

**Files:** runtime config, handler, config tests, public API manifest check.

**Change:** add an internal detailed initialization function and retain the
existing string wrapper.

**Validation:** first init reports created; second init reports unchanged;
existing bytes and public consumer compile remain stable.

**Deployable:** yes; public function compatibility preserved.

### Slice 9 — IE-09: derive setup-agent verdict

**Files:** command handler, agent-setup tests.

**Change:** compute configured/partial/blocked summary from result arrays.

**Validation:** all-valid, mixed-skip, and all-skipped outcomes render distinct
verdicts.

**Deployable:** yes; no stored format changes.

### Slice 10 — IE-10: expose suppression scope and lifetime

**Files:** command handler, suppression tests, command docs.

**Change:** render finding/check/file scope, expiry or indefinite state,
adjudication code, and evidence count.

**Validation:** scoped expiring and unscoped indefinite decisions render the
correct effective policy; JSON remains stable.

**Deployable:** yes; persisted record unchanged.

### Slice 11 — IE-11: add same-plan cleanup preview and target feedback

**Files:** cleanup descriptor/handler, cleanup verification/handler tests,
skills and command docs.

**Change:** add `--dry-run`, share selection/verification between preview and
apply, print exact file/symbol/LOC selection, and clarify dirty-loss help.

**Validation:** preview and apply select identical targets; preview leaves the
working tree byte-identical; failed verification never prints an applicable
preview; apply feedback names every mutated target.

**Deployable:** yes; additive preview and feedback.

### Slice 12 — IE-12: distinguish transport completion

**Files:** output pagination, pagination/session tests, command docs/skills.

**Change:** replace the human completion footer with the existing
transport-versus-coverage distinction.

**Validation:** paged human output retains exact continuation, line boundaries,
and content bytes; only the footer wording changes; JSON is byte-compatible.

**Deployable:** yes; no protocol change.

### Slice 13 — integrated docs and gates

**Files:** generated command reference/catalog, README and affected skills,
review/plan status.

**Change:** regenerate descriptor-owned docs, reconcile examples, record final
verification and any accepted detector findings.

**Validation:** generated-doc tests, skill link check, full repository gates.

**Deployable:** yes; closes the program.

## Attack record

### A1 — accidental bare uninstall

**Invariant:** I1.  
**Attack:** an agent intends to remove checkout hooks and runs the shortest
plausible command, `scip-query uninstall`.  
**Outcome:** HOLE — repaired by Slice 2; no-scope real removal refuses.

### A2 — removal from a linked/local CLI

**Invariant:** I2 and I7.  
**Attack:** the package can edit managed project hooks but cannot produce an
installable persistent command identity; the user asks only to preview or
remove.  
**Outcome:** HOLE — repaired by Slice 1; removal no longer touches identity
construction.

### A3 — retained-list attention failure

**Invariant:** I4.  
**Attack:** the changed removal set is followed by more than one hundred
untouched entries; the operator misses one real target in the noise.  
**Outcome:** HOLE — repaired by Slice 3; default output ranks changed targets
and aggregates untouched state.

### A4 — guided command through an agent shell

**Invariant:** I3.  
**Attack:** a model runs `setup --guided` without a TTY and the program selects
recommended global and repository actions.  
**Outcome:** HOLE — repaired by Slice 4; impossible guided mode refuses before
mutation.

### A5 — remove plus force

**Invariant:** I3.  
**Attack:** a caller supplies `setup-hooks --remove --force` believing force
will reinstall or override the tombstone.  
**Outcome:** HOLE — repaired by Slice 5; contradictory modes refuse.

### A6 — watch override against live daemon

**Invariant:** I3 and I4.  
**Attack:** a user responds to high CPU by running
`watch --daemon --cooldown 60000`; a live service is reused with its old
cooldown.  
**Outcome:** HOLE — repaired by Slice 6; the invocation refuses and names the
stop/start sequence.

### A7 — incomplete polyglot evidence

**Invariant:** I4.  
**Attack:** one language indexer fails, `--allow-partial` publishes the other,
and the agent retains only the final success-looking line.  
**Outcome:** HOLE — repaired by Slice 7; the final result names partial state
and every omitted language.

### A8 — existing config interpreted as replaced

**Invariant:** I4.  
**Attack:** an existing hand-tuned config survives `init`, but the caller
believes detected languages/defaults were written and acts on that model.  
**Outcome:** HOLE — repaired by Slice 8; the committed revision result selects
the message.

### A9 — skipped setup hidden by final sentence

**Invariant:** I4.  
**Attack:** malformed managed markers skip both agent files; the final line
still says agents now know the workflow.  
**Outcome:** HOLE — repaired by Slice 9; all-skipped is a blocked verdict.

### A10 — indefinite broad suppression

**Invariant:** I4.  
**Attack:** an agent omits expiry/check/file constraints and retains only a
success path, not the indefinite policy it wrote.  
**Outcome:** HOLE — repaired by Slice 10; effective scope and lifetime are in
the success feedback.

### A11 — verified but unintended cleanup

**Invariant:** I2, I4, and I7.  
**Attack:** `cleanup-apply --verified --all` compiles after deleting a larger
set than the operator intended.  
**Outcome:** HOLE — repaired by Slice 11; same-plan dry-run and exact target
feedforward exist. Real application remains explicit and reports targets.

### A12 — transport completion mistaken for evidence completeness

**Invariant:** I5.  
**Attack:** the last transport page says “output complete” while command
coverage remains bounded; an agent claims a complete relationship set.  
**Outcome:** HOLE — repaired by Slice 12; the footer names transport and the
remaining coverage obligation.

### A13 — old scripts

**Invariant:** I6.  
**Attack:** a script uses explicit `uninstall --project`, ordinary watch
reuse, structured JSON, or output cursors from the previous version.  
**Outcome:** HELD by P2, P5, P11, and Slices 2, 3, 6, 12: explicit successful
forms and structured protocols remain valid.

### A14 — concurrent config initialization

**Invariant:** I4 and I7.  
**Attack:** another process creates `.scipquery.json` after an initial
existence check.  
**Outcome:** HELD by P7 and Slice 8: message selection comes from the
revision-aware mutation result, not a separate pre-check.

### A15 — dry-run drift

**Invariant:** I2.  
**Attack:** preview uses a different planner or stale target list from apply.  
**Outcome:** HELD by P10 and Slice 11: preview and apply share the same
invocation-local plan, selection, and verification pipeline.

### A16 — accidental user-file ownership expansion

**Invariant:** I7.  
**Attack:** concise uninstall output tempts implementation to stop checking
untouched entries.  
**Outcome:** HELD by Slice 3: only rendering changes; the complete structured
`left` inventory and ownership checks remain.

## Coverage matrix

| Authority/writer | Purpose | Reversibility | Failure | Concurrency | Human/agent experience | Attack |
| --- | --- | --- | --- | --- | --- | --- |
| `uninstallSkills` | explicit scope | reinstall links | preview/removal failure | concurrent link change remains existing ownership logic | concise changed-target output | A1, A2, A3, A16 |
| project hook writer | install/remove/decline | force reinstall | identity unavailable | revision-aware hook mutation | preview and mode-specific result | A2, A5 |
| `setupAgent` | managed guidance | rerun/remove | skipped target | revision-aware managed file | derived verdict | A9 |
| watcher controller | process lifecycle | stop/start | live reuse | live classification before start | no ignored timing | A6 |
| reindex publisher | evidence refresh | complete reindex | skipped language | existing publication protocol | partial warning | A7 |
| config initializer | first config | manual edit | existing/racing writer | revision-aware mutation | created vs unchanged | A8, A14 |
| suppression writer | adjudicated waiver | expiry/replacement/deletion | conflict/invalid evidence | revision CAS | visible scope/lifetime | A10 |
| cleanup applier | verified deletion | Git except dirty loss | checker/dirty failure | current working-tree inspection | same-plan preview | A11, A15 |
| output snapshot writer | complete byte delivery | restart command | missing/expired snapshot | immutable cursor binding | transport wording | A12, A13 |

No authority row is unattacked.

## Execution and commit order

Slices 1-3 share uninstall infrastructure and land in that order. Slice 1
restores the preview/removal path before Slice 2 relies on scope-free dry run.
All other behavior slices are independent. Slice 13 depends on every
descriptor and wording change.

Working agreement:

- one commit per numbered slice;
- run the focused tests named by the slice before committing it;
- never stage unrelated or concurrently produced changes;
- after each source change, wait for the active watcher to refresh rather than
  starting a competing reindex;
- run the relevant postcheck and `scip-query diff-gate` at every coherent
  boundary;
- record every deviation, deferred item, or accepted finding in this plan.

## Ship order and one-way doors

There is no persisted schema migration or cursor-version change. The only
intentional tightening is that bare real uninstall and impossible/ignored
mode combinations fail where they previously acted or appeared to succeed.
Rollback is a code rollback; records written by the new version remain
readable by the old version because no record shape changes.

## Verdict

A plan is **PLANNED-COMPLETE** iff every authority row is attacked, every
attack is either defended by a cited premise/slice or retained as a repaired
hole, every consumer has a disposition, and no unresolved one-way door
remains.

Result: **PLANNED-COMPLETE** — 16 attacks, 12 holes to be repaired by Slices
1-12, 0 accepted holes, 0 blank authority rows, and no persistent-data or
protocol migration.

## Deviation ledger

None at planning time.

## Deferred list

- A separate unit-testing lens over the entire repository remains a future
  review; this program tests only the interaction contracts it changes.
- Persisting daemon timing options in `WatchServiceState` is deliberately
  deferred because refusing ignored overrides solves the confirmed defect
  without a protocol migration.
- Human confirmation prompts are deliberately excluded because they do not
  prevent mistaken plans and would obstruct agent automation.
