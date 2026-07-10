# Setup Scope and Outcome Records

Date: 2026-07-10
Status: Complete
Parent: [`2026-07-10-setup-automatic-indexing.md`](./2026-07-10-setup-automatic-indexing.md)

## Goal

Make setup distinguish three kinds of state and enforce that distinction:

1. **Repository records** are shared project facts, policy, guidance, and
   history whose value comes from surviving clones and branches; they belong in
   Git.
2. **Checkout preferences** are integration choices for one clone and machine;
   they must work without appearing in commits.
3. **Runtime state** is rebuildable process/cache state; it belongs outside the
   repository and is never committed.

Close the remaining setup integrity gaps at the same time: honor every guided
choice, make the installed Stop hook record caught/resolved/suppressed outcome
events, teach agents which records to commit, and report preserved records on
uninstall.

## Current State

- `scip-query setup --guided` asks one yes/no question for every planned action.
  Automatic indexing, agent guidance, and hook choices flow into setup options,
  but the `install-indexers` and `install-parser-runtimes` selections do not.
  Source: `scip-query code guidedProjectSetupOptions --json`,
  `scip-query code planGuidedProjectSetup --json`.
- `setup-hooks` writes `.codex/hooks.json` and Claude settings under the
  checkout. `--shared` can intentionally select tracked
  `.claude/settings.json`. Source:
  `scip-query code installProjectAgentHooks --json`,
  `scip-query code handleSetupHooks --json`.
- This repository currently tracks `.codex/hooks.json` and
  `.claude/settings.json`; the former is empty and the latter contains only
  scip-query hooks. Filesystem evidence: `git ls-files '.codex/**' '.claude/**'`
  plus direct inspection.
- Hook-only removal exists as `setup-hooks --remove`; project uninstall removes
  hooks plus managed AGENTS/CLAUDE blocks. It preserves project config and
  dossier files but does not list suppression/outcome records among preserved
  state. Source: `scip-query code handleSetupHooks --json`,
  `scip-query code uninstallProject --json`,
  `scip-query code projectFilesLeftInPlace --json`.
- Suppressions are one JSON file per accepted decision under
  `.scipquery/suppressions/`. Source:
  `scip-query code writeSuppressionFile --json`.
- Outcome events already have a correct append-only format and merge policy:
  `.scipquery/ledger/events.jsonl`, with one JSON object per line, a scoped
  `merge=union` attribute, and read-side deduplication. Source:
  `scip-query code appendOutcomeEvents --json`,
  `scip-query code ensureLedgerGitattributes --json`.
- The legacy `diff-gate --hook` path updates the SQLite outcome ledger and
  mirrors transitions into the committed event log. Installed project hooks
  call `hook-stop`, whose `runStopHookDiffGate` currently calls `diffGate`
  directly and bypasses both updates. Source:
  `scip-query code 'src/runtime/query-commands/impact.ts:245-305' --json`,
  `scip-query code runStopHookDiffGate --json`,
  `scip-query code scipHookGroup --json`.
- Managed AGENTS guidance tells agents to run verification but does not tell
  them to commit suppression files, outcome events, or the ledger's
  `.gitattributes`. Source:
  `scip-query code writeInstructionsBlock --json`.

## Reuse Audit

- Extend `installProjectAgentHooks`; do not create a second hook installer.
  Its four direct product consumers are the setup-hooks handler, full setup,
  uninstall, and setup compatibility export. Source:
  `scip-query refs installProjectAgentHooks --json` and
  `scip-query affected installProjectAgentHooks --json`.
- Extract the existing outcome-update block from the legacy hook handler into
  one shared runtime function. A new unit is justified because two independent
  entry points must perform the identical state transition, while importing
  the full query-command module into agent hooks would create the wrong
  dependency direction. Source:
  `scip-query refs appendOutcomeEvents --json`,
  `scip-query call-graph appendOutcomeEvents --json`.
- Extend `ProjectSetupOptions` with one indexer-remediation decision; its only
  external consumers are the setup handler and guided option builder. Source:
  `scip-query refs ProjectSetupOptions --json`,
  `scip-query affected ProjectSetupOptions --json`.
- Remove the parser-runtime question instead of inventing a package installer.
  Setup has no parser-runtime remediation boundary, and an `npm install` side
  effect would mutate repository dependencies rather than a user preference.
- Reuse `.git/info/exclude` as Git's per-checkout exclusion mechanism. Do not
  mutate the committed `.gitignore`; the exclusion exists specifically to keep
  clone-local files out of repository policy.

## Testability Design

| Behavior | Test seam | Dependencies | Pure core | Side-effect boundary | Contract |
| --- | --- | --- | --- | --- | --- |
| Classify setup actions | `planGuidedProjectSetup` and selection summary formatter | readiness/file facts | scope/action selection | terminal prompt only | every action declares `repository`, `checkout`, or `user` |
| Honor indexer consent | `runProjectSetup({ installIndexers })` | mocked readiness/installers | remediation decision | package-manager process | decline performs no install attempt; non-guided default preserves current remediation |
| Keep hooks local | `installProjectAgentHooks` in a temporary Git repo | Git CLI and filesystem | tracked-target decision and exclude block rendering | provider config plus `.git/info/exclude` | untracked local targets are excluded; tracked targets are never mutated |
| Record Stop outcomes | shared `recordDiffGateOutcomes` plus `runStopHookDiffGate` | DB, clock, Git HEAD, filesystem append | observed/symbol transition input | SQLite ledger and JSONL append | caught then absent produces caught/resolved events; append failure does not falsify gate result |
| Teach commit policy | `setupAgent` managed block fixture | filesystem | static managed instructions | AGENTS/CLAUDE writes | repository records are commit-required; hook files are explicitly local |
| Preserve records on uninstall | `uninstallProject` report | filesystem existence | preserved-path classification | hook/guidance removal | suppressions and ledger remain and are named in `left` |

## Implementation Phases

### 1. Make hook installation checkout-local

- [x] **Files**: `src/runtime/agent-hooks.ts:39-178`,
  `src/runtime/commands/command-handlers.ts:832-858`,
  `src/runtime/commands/command-descriptors.ts`
- **Source**: `scip-query plan-context src/runtime/agent-hooks.ts --json`;
  `scip-query surface src/runtime/agent-hooks.ts --json`.
- **Change**: always target `.codex/hooks.json` and
  `.claude/settings.local.json`; preserve `--shared` only as a deprecated
  compatibility input that installs locally and warns. Add/remove a marked
  local-hook block in `.git/info/exclude`. Refuse to mutate a target that Git
  already tracks. Report Git-excluded targets explicitly.
- **Validation**: temporary-repository tests for install, idempotency, remove,
  tracked-target refusal, and deprecated `--shared` behavior.

### 2. Label and honor guided setup choices

- [x] **Files**: `src/runtime/project-setup.ts:117-232,235-340,613-664`,
  `src/runtime/commands/command-handlers.ts:1119-1211`
- **Source**: `scip-query code planGuidedProjectSetup --json`;
  `scip-query code guidedProjectSetupOptions --json`.
- **Change**: add an action scope, render it in prompts/summaries, wire
  `install-indexers` into setup options, and remove the decorative parser
  runtime action. Add setup report buckets for repository, checkout, and user
  changes while retaining `filesWritten` compatibility.
- **Validation**: pure planner/summary tests plus setup controls proving a
  declined indexer action never calls the installer.

### 3. Share and wire outcome recording

- [x] **Files**: create `src/runtime/diff-gate-outcomes.ts`; edit
  `src/runtime/query-commands/impact.ts:216-305` and
  `src/runtime/agent-hooks.ts:447-468`
- **Source**: `scip-query code 'src/runtime/query-commands/impact.ts:245-305' --json`;
  `scip-query code runStopHookDiffGate --json`;
  `scip-query refs appendOutcomeEvents --json`.
- **Change**: move observed-finding, SQLite transition, symbol mapping, and
  committed JSONL append into one shared orchestrator used by both hook paths.
  Record even when the current run has zero findings so prior findings can
  become resolved. Keep event-log I/O non-blocking and observable.
- **Validation**: a real temporary DB/Git fixture that runs caught then clean
  and proves `events.jsonl` plus `computeEffectiveness` report one fixed item;
  hook-path wiring assertion and append-failure control.

### 4. Make repository-record policy unavoidable

- [x] **Files**: `src/runtime/agent-setup.ts:116-143`,
  `src/runtime/uninstall.ts:43-58`, README, agent guide, command reference,
  setup roadmap/ledger, generated skills
- **Source**: `scip-query code writeInstructionsBlock --json`;
  `scip-query code projectFilesLeftInPlace --json`;
  `scip-query co-change src/runtime/commands/command-descriptors.ts --json --full`.
- **Change**: managed agent guidance must require committing/publishing
  suppression and outcome records with their change and must forbid committing
  local hook files. Uninstall must name preserved config, suppressions, ledger,
  and dossier state. Documentation must present the three scopes and exact
  commands.
- **Validation**: managed-block and uninstall fixtures, regenerated command
  docs, doc-drift, and package setup/hook install smoke.

### 5. Remove already-tracked local hook artifacts

- [x] **Files**: delete `.codex/hooks.json` and `.claude/settings.json`
- **Source**: repository filesystem inspection showed the Codex file is empty
  and the Claude file contains only scip-query-managed hooks.
- **Change**: remove both from Git. Preserve the ignored
  `.claude/settings.local.json` user opt-out. After commit, a local
  `setup-hooks` run may recreate only excluded checkout files.
- **Validation**: `git ls-files '.codex/**' '.claude/**'` returns no scip-query
  hook config, while a temporary installed-project smoke proves local hooks
  still work.

## Stress-Test Findings

- A tracked provider config may contain unrelated team hooks. Local setup must
  skip it rather than rewrite or untrack it.
- `.git/info/exclude` can be absent, live in a worktree gitdir, or contain user
  entries. Resolve it through Git, preserve all unrelated lines, and own only a
  marked block.
- A clean Stop run is not a no-op for history: it resolves previously open
  findings and therefore must still update the ledger.
- Two branches may append the same transition. Keep JSONL `merge=union` and
  read-side deduplication; individual event files add filesystem noise without
  improving the accepted merge contract.
- Outcome-log failure must not turn a correct diff-gate result into success or
  failure. Surface a note while preserving gate semantics.
- Repository guidance changes are shared project records and should be
  committed only when the guided user selects them. Hook installation remains
  local even when setup also produces repository changes in the same run.
- `--shared` is a public CLI input. Preserve parsing compatibility for this
  release, but stop its tracked behavior immediately and label it deprecated.

## Ship Order

1. Local hook exclusion and tracked-target safety.
2. Guided scope/consent wiring.
3. Shared outcome recorder and caught-to-fixed integration test.
4. Agent/uninstall/docs reconciliation.
5. Remove tracked hook artifacts, package smoke, full tests, reindex,
   diff-gate, and commit.

No suppression or outcome record is deleted. Hook rollback is
`scip-query setup-hooks --remove`; repository guidance rollback remains the
managed-block portion of `scip-query uninstall --project`.

## Verification Evidence

- Focused setup, hook-locality, installed-hook outcome, agent-guidance,
  uninstall, outcome-event, and effectiveness suites passed 62 tests across 9
  files.
- The full repository suite passed 1,240 tests across 180 files; typecheck,
  lint, and the production build passed.
- The packed package contained 333 files in 826,805 bytes at SHA-256
  `a18dd564e24ef944c460cd306292079e8f93455ef0a8d80e5735711d3589df0d`.
  In an isolated Git repository, both provider hooks installed, both resolved
  to the fixture's `.git/info/exclude`, `git status` remained clean, and
  removal left only the ignored Claude decline marker.
- `doctor`, capability status, diff impact, recent duplicates, unused params,
  incomplete migration, cleanup verification, self-audit, and full doc drift
  completed. The health baseline still reports the previously documented 165
  repository-wide deltas (and one now-fixed baseline identity); this slice
  does not rewrite that stale baseline.
- The final reindex reused the fresh generation in 0.3 seconds. Diff gate ran
  all eight configured checks with zero blocking findings and zero advisories.
