# scip-query — Interaction-and-error audit

Date: 2026-07-29  
Audited revision: `37c8ab7b39e0d346b6186d65bc2a52eb0a88ee92`  
Audited package version: `0.19.9`  
SCIP generation: `5e6a6a935f6a` (fresh when the review began)

Scope: the human- and agent-facing command flows that mutate source,
configuration, global skills, project hooks, watcher state, suppressions, or
index state, plus the pagination layer that tells an agent whether it has
retrieved enough evidence to reason.

Method: this review applied the `interaction-and-error` lens and the
`scip-audit` evidence discipline. Native reads established literal option
semantics, branch order, and rendered messages. `scip-query plan-context`,
`refs --full`, `trace`, `code`, `outline`, and `health` established
compiler-resolved identities and consumers. Safe runtime probes exercised
`init` and uninstall dry runs. No sub-agents were used.

The pre-change focused baseline passed **8 files and 147 tests** when allowed
to use the repository's global cache. The same command inside the restricted
sandbox produced seven `EPERM` failures while creating cache directories;
those were environment failures, not product failures.

This report records **twelve confirmed findings**:

- **six high-severity findings:** IE-01, IE-02, IE-04, IE-06, IE-07, IE-11;
- **six medium-severity findings:** IE-03, IE-05, IE-08, IE-09, IE-10, IE-12.

No production code, tests, configuration, generated command docs, or skills
were changed while producing this report.

---

## 1. Outcome

scip-query already contains strong interaction controls:

- mutating TLA+ commands refuse to overwrite existing files unless `--force`
  is explicit;
- `setup-ci` has a non-writing `--dry-run`;
- cleanup refuses to mutate without `--verified` and an explicit batch
  selection;
- watcher lifecycle modes reject `--daemon`, `--status`, and `--stop` when
  more than one is supplied;
- suppression creation requires a reason code and inspectable
  counterevidence and uses revision matching for replacement;
- output continuation binds a cursor to the command, invocation, page size,
  output hash, and immutable snapshot;
- oversized JSON deliberately prints its paging instruction both before and
  after the raw payload so a client that drops either edge can still expose
  the warning;
- managed agent blocks and hook files preserve user-owned content and refuse
  unsafe ownership assumptions.

The remaining failures fall on the two sides of an action cycle.

The **execution failures** let a person or agent choose one visible action
while the program performs another:

- bare `uninstall` means both global and project removal without saying so;
- project hook removal unnecessarily enters install-only identity resolution;
- `setup --guided` stops being guided when there is no terminal;
- watcher timing options are accepted in modes that ignore them;
- a partial reindex is presented like a complete one;
- cleanup application can mutate many symbols without a non-writing preview
  or target list.

The **evaluation failures** happen after the action:

- uninstall floods ordinary output with every untouched personal skill;
- hook removal has no preview mode and ends with an installation-oriented
  summary;
- `init` reports a write that did not occur;
- `setup-agent` asserts success even when every target was skipped;
- suppression output omits scope and whether the decision is indefinite;
- human pagination calls transport completion simply “output complete,”
  obscuring the separate command-coverage question.

The repair direction is therefore not “add confirmation prompts.” These
commands are frequently run by agents and scripts, where routine prompts
become either reflexes or automation blockers. The correct controls are
explicit modes, non-writing previews, independent sensibility checks,
unambiguous state feedback, and recoverable or narrowly scoped mutations.

---

## 2. Essential concepts

An **interaction contract** is the public command behavior through which a
human or agent selects an action and interprets its result. Its real referents
here are command names, flags, help text, exit statuses, stdout and stderr,
written files, process state, and continuation commands. What makes it a
contract rather than incidental wording is that callers choose later actions
from the meaning it presents.

A **slip** is an execution error in which the intended goal and plan are
correct but the performed command or selected target differs. Adjacent mode
flags, implicit destructive defaults, and similar-looking safe and destructive
forms create slip paths.

A **mistake** is a planning error in which the command is executed exactly as
intended but the intent rests on a false model of current state or
consequence. A confirmation cannot correct that model; visible scope,
effective settings, partial-state warnings, and plausibility checks can.

**Feedforward** is information shown before a consequential action that names
what will change, which targets are included, and whether recovery is
possible. It differs from feedback because feedback arrives after the commit
point.

**Feedback** is the observable result that lets a caller determine what
happened to which target. Useful feedback is immediate, proportionate, and
specific. A categorical success after skipped writes is false feedback; a
hundred lines naming untouched files is excessive feedback.

A **mode** is a command state in which the same option set is interpreted by a
different operation. `watch --daemon`, `watch --status`, and `watch --stop`
are modes because timing flags affect only some of them. A mode remains usable
only when invalid combinations are rejected and the active interpretation is
visible.

A **transport page** is one ordered character segment of a command's rendered
bytes, distinguished from other segments by an immutable snapshot and cursor.
Transport completion proves all rendered characters were retrieved. It does
not prove the command examined every semantic result unit.

**Command coverage** is the command-owned account of whether all relevant
symbols, references, files, candidates, or history records were examined.
Transport completion and command coverage answer different questions and must
not share an undifferentiated “complete” label.

---

## 3. Finding register

| ID | Severity | Error class | Finding | Evidence |
| --- | --- | --- | --- | --- |
| IE-01 | High | Mistake | Bare `uninstall` silently selects both global and project scope | Source-confirmed |
| IE-02 | High | Execution/recovery | Project hook removal resolves an install-only CLI identity and can fail before previewing or removing anything | Runtime-confirmed |
| IE-03 | Medium | Evaluation/noise | Uninstall prints every untouched personal skill by default | Runtime-confirmed |
| IE-04 | High | Mode/mistake | `setup --guided` silently becomes noninteractive defaults outside a TTY and conflicts with `--yes`/`--json` | Source-confirmed |
| IE-05 | Medium | Mode/recovery | Hook removal has no dry run, accepts `--remove --force`, and renders an installation-oriented final message | Source-confirmed |
| IE-06 | High | Mode/mistake | Watch timing options are silently ignored in status/stop modes and when daemon start reuses a live service | Complete flow trace |
| IE-07 | High | Evaluation/evidence | `reindex --allow-partial` human output does not say an incomplete index was published | Source-confirmed |
| IE-08 | Medium | Evaluation | `init` says “Config written” when an existing config was left unchanged | Runtime-confirmed |
| IE-09 | Medium | Evaluation | `setup-agent` asserts agents are configured even when writes were skipped | Source-confirmed |
| IE-10 | Medium | Evaluation | Suppression success omits effective scope and indefinite expiry | Contract/source-confirmed |
| IE-11 | High | Mistake/recovery | `cleanup-apply` lacks a non-writing preview and reports only aggregate counts after mutation | Source-confirmed |
| IE-12 | Medium | Evaluation/evidence | Human pagination labels transport completion as undifferentiated output completion | Source-confirmed |

---

## 4. Detailed findings

### IE-01 — High — Bare uninstall silently selects both scopes

**Current behavior**

- `runUninstall` in `src/runtime/uninstall.ts:26-30` treats absence of
  `--global` and `--project` as a request for both.
- `handleUninstall` rejects both flags together but does not reject neither.
- `scip-query uninstall --help` describes the two flags but does not state the
  destructive default.

**Why this fails**

The command name identifies removal but not its target. Project-local hooks
and user-global skill links are distinct resources with different owners and
blast radii. Choosing both from silence asks the operator to know an invisible
default at the exact point where explicit scope matters most.

**Attempted refutation**

- `--dry-run` exists, but it is optional and bare `uninstall` is still the
  shortest destructive form.
- Only scip-query-owned symlinks and managed blocks are removed, which limits
  ownership risk but does not make the selected scope intended.
- Git can recover project files, but it cannot restore user-global links from
  the repository checkout.

**Required repair**

Require an explicit scope for real removal. Preserve `uninstall --dry-run`
without a scope as a safe preview of both scopes. The error must name the two
valid destructive commands and the scope-free preview command.

**Required tests**

- no scope and no dry run refuses before any removal;
- no scope plus dry run previews both scopes;
- exactly one explicit scope still works;
- both explicit scopes remain rejected.

---

### IE-02 — High — Hook removal enters an install-only identity path

**Current behavior**

`installProjectAgentHooks` in `src/runtime/agent-hooks.ts:220-260` resolves
`projectHookCommandPrefix(projectRoot)` before checking `opts.remove`.
Removal never uses that command prefix.

The runtime probe `scip-query uninstall --dry-run` failed before producing a
preview:

```text
error: Cannot install persistent hooks without a scip-query CLI identity
outside the target checkout. Install scip-query globally and rerun setup-hooks.
```

`uninstall --global --dry-run` succeeded, isolating the failure to the project
hook path.

**Why this fails**

Removing an owned hook is a different operation from constructing an
executable command for a new hook. Making removal depend on installation
identity can strand the very integration the user is trying to remove. The
error also recommends installation while handling uninstallation.

**Attempted refutation**

- A normally published global install may satisfy identity resolution, but
  local package development and linked installs are supported invocation
  forms and must still be uninstallable.
- The failure happens in dry-run mode, so it is not protecting a mutation.

**Required repair**

Return from the removal branch before resolving an install command prefix.
Test both dry-run and real removal with a runtime that would throw if prefix
resolution were reached.

---

### IE-03 — Medium — Uninstall overwhelms the result with untouched skills

**Current behavior**

`handleUninstall` prints every entry in `report.global.left`.
The global-only dry-run probe printed the owned links that would be removed,
then more than one hundred `left:` lines for unrelated personal skills and
files.

**Why this fails**

The useful facts are the targets that would change and the count of entries
proved untouched. Listing every non-target spends the attention needed to
review the actual removal set. For an agent it also consumes context without
adding a decision-relevant fact.

**Attempted refutation**

- The complete list is useful for forensic inspection, so it should remain
  available.
- Pagination prevents transport loss, but it does not make irrelevant detail
  useful.
- JSON consumers already receive the complete structured `left` array.

**Required repair**

Default human output must summarize untouched entries by count. Add a
`--verbose` mode that prints the complete retained list. Keep JSON unchanged.

---

### IE-04 — High — Guided setup is not necessarily guided

**Current behavior**

- `handleSetup` calls `guidedProjectSetupOptions` when `--guided` is supplied.
- That function prompts only when stdin and stdout are TTYs.
- Otherwise it silently selects recommended actions and detected languages.
- `--guided --json` therefore executes defaults instead of opening the
  checklist named by the flag.
- `--guided --yes` supplies two incompatible selection policies; a terminal
  can still prompt because the inner TTY check does not consider `--yes`.

**Why this fails**

The word “guided” identifies a user-selection mode whose defining
characteristic is that no recommended repository/global mutation becomes a
decision until the user sees and selects it. A noninteractive default run is a
different mode, not a degraded implementation of the same one.

**Attempted refutation**

- Recommended actions are conservative and individually reported afterward.
  That feedback arrives after the commit point and cannot replace selection.
- `--yes` intentionally supports automation, which is why it must remain
  distinct from `--guided`.

**Required repair**

Reject `--guided` unless both streams are interactive. Reject
`--guided --yes` and `--guided --json` with exact alternatives. Perform these
checks before readiness inspection or any filesystem/global mutation.

---

### IE-05 — Medium — Hook-removal mode lacks preview and accepts conflict

**Current behavior**

- `setup-hooks --remove` deletes owned hook configuration and records a
  declined tombstone.
- The underlying removal implementation already supports `dryRun`, but the
  public command exposes no `--dry-run`.
- `--remove --force` is accepted; the removal branch returns before `force`
  can matter.
- After a successful removal, the handler can finish with “No project-local
  hook config was written,” an installation-oriented statement that does not
  say removal or opt-out occurred.

**Why this fails**

Removal and forced installation are mutually exclusive modes. Accepting both
silently teaches a false option model. A tombstone also changes future setup
behavior, so a preview needs to show both immediate removal and remembered
opt-out.

**Required repair**

Expose `--dry-run` for removal, reject it without `--remove`, reject
`--remove --force`, and render mode-specific `would remove`, `removed`, and
opt-out summaries.

---

### IE-06 — High — Watch timing flags can be accepted and ignored

**Current behavior**

- `handleWatch` parses timing options before branching into status, stop,
  daemon, or foreground modes.
- `--status` and `--stop` accept the timing options even though those modes do
  not apply them.
- `ensureWatchService` returns an existing live service at
  `src/runtime/watch-service.ts:282-285` before using
  `opts.watchOverrides`.
- `watch --daemon --cooldown ...` can therefore print “Reused watch service”
  while the requested cooldown was never applied.
- `WatchServiceState` does not persist the effective timing configuration, so
  the caller cannot discover the mismatch from that success message.

**Why this fails**

The accepted command is syntactically valid in every affected case. Nothing
contradicts the caller's belief that the requested setting became effective.
This is a mistake-producing interface, and the result can directly recreate
the excessive CPU/reindex behavior that motivated earlier fixes.

**Attempted refutation**

- CLI options commonly apply only to one invocation, but a reused daemon
  means even that invocation did not apply them.
- Automatically restarting the live service would make the option effective,
  but it would also interrupt work without explicit authorization.

**Required repair**

Reject timing options with `--status` and `--stop`. Before daemon ensure, if a
live service exists and any override was supplied, refuse with an exact
stop-then-start sequence. Preserve reuse when no override was requested.
Started-daemon feedback must name the effective overrides and state that they
are process-local, not persisted configuration.

---

### IE-07 — High — Partial reindex looks complete in human output

**Current behavior**

`ReindexResult` contains `skipped: { language, reason }[]`. When
`--allow-partial` permits publication with skipped languages, the metadata is
correctly marked `partial`. `handleReindex`, however, prints only:

```text
Indexed <successful languages> in <duration>
```

The skipped languages, reasons, and partial status are absent from human
output.

**Why this fails**

An incomplete index can omit definitions, references, callers, and
dependencies for an entire language. Presenting it like an ordinary success
causes later evidence claims to inherit an undisclosed boundary.

**Attempted refutation**

- JSON includes the `skipped` array, so programmatic consumers can detect the
  state.
- The user explicitly supplied `--allow-partial`, but that permits
  publication; it does not imply they know which languages failed this run.
- Progress output may have mentioned an indexer failure, but the final result
  is the durable summary agents retain.

**Required repair**

When `skipped` is nonempty, print a prominent partial-index warning, every
skipped language with its reason, and a statement that cross-language
relationship evidence is incomplete until a complete reindex succeeds.

---

### IE-08 — Medium — Init reports a write that did not happen

**Current behavior**

`initProjectConfig` uses revision-aware mutation and correctly leaves an
existing `.scipquery.json` unchanged. It returns only the path.
`handleInit` always prints `Config written to ...`.

A runtime probe against the existing repository printed the write message;
`git status --short` remained empty.

**Why this fails**

The implementation protects user data, but the feedback denies that
protection. A caller may wrongly believe detected languages and current
defaults replaced the existing configuration.

**Required repair**

Add an internal structured initialization result containing `path` and
`changed`, while preserving the existing public string-returning function for
compatibility. Render “created” only for a committed write and “already
exists; left unchanged” otherwise.

---

### IE-09 — Medium — Setup-agent can assert success after skips

**Current behavior**

`setupAgent` returns `written`, `unchanged`, and `skipped`. The handler prints
those rows, then unconditionally says:

```text
Agents reading this project now know to route through the scip-query skills
and gate their diffs.
```

Malformed markers, unreadable files, revision conflicts, a missing Git hook
directory, or a foreign pre-commit hook can all populate `skipped`.

**Why this fails**

The detailed rows and categorical summary can contradict one another. Agents
and humans tend to retain the final sentence as the verdict, so the most
prominent feedback can erase the failure evidence printed immediately above.

**Required repair**

Render configured, partial, or blocked state from the result counts. Only
claim complete guidance when every requested target is written or already
valid and none is skipped.

---

### IE-10 — Medium — Suppression feedback hides scope and lifetime

**Current behavior**

The suppression agent contract promises identity, path, scope, and expiry.
Human output prints only disposition, path, and revision. It does not say:

- whether check/file constraints were supplied;
- whether expiry is set;
- that omission of expiry creates an indefinite decision;
- which adjudication code and evidence count justified the decision.

**Why this fails**

A suppression is a durable classification that makes a detector finding stop
blocking. Its safety depends on narrow scope, inspectable evidence, and
reversibility. A path alone does not let the caller evaluate those properties
without opening the file.

**Required repair**

After creation or replacement, print effective finding/check/file scope,
expiry (`none — indefinite` when absent), reason code, and evidence count.
Keep JSON's full record-oriented result stable.

---

### IE-11 — High — Cleanup application has no non-writing preview

**Current behavior**

`cleanup-apply` requires `--verified` and exactly one of `--batch` or `--all`.
It computes a plan, verifies selected batches, mutates the working tree, and
then prints only aggregate batch, symbol, and line counts.

The descriptor promises “applied files, deletions, verification, and refusal
reasons,” but successful human output does not name the files or symbols.
The command exposes no `--dry-run`.

**Why this fails**

Compiler success answers whether the edited program still passes the
available checker. It does not answer whether the operator intended this set
of deletions. That second question requires target feedforward before the
commit point. This matters especially with `--all` and `--force-dirty`, where
one accepted command can remove many symbols or uncommitted edits.

**Attempted refutation**

- `cleanup-plan --verify --patch` can preview the plan, but `cleanup-apply`
  does not require that prior invocation and cannot prove the preview refers
  to the same current plan.
- Git can recover clean tracked content, but not necessarily uncommitted edits
  allowed by `--force-dirty`.
- The explicit command name and `--verified` reduce slips, not mistaken scope.

**Required repair**

Add `--dry-run` that performs current planning and verification, prints the
selected files/symbols/LOC and verification oracle, and performs no mutation.
Real application must print the same selected target summary before mutation
and an applied target summary afterward. Strengthen `--force-dirty` help to
state that uncommitted edits may be deleted.

---

### IE-12 — Medium — Human page completion obscures semantic coverage

**Current behavior**

The JSON page envelope correctly says:

```text
OUTPUT COMPLETE: all rendered characters have been retrieved. Evaluate the
command result's own coverage separately.
```

The human footer says only:

```text
[scip-query output complete]
```

**Why this fails**

Agents normally consume human output. A complete transport snapshot can still
contain a bounded, sampled, heuristic, or otherwise incomplete command
result. The shorter footer collapses those two states precisely at the moment
the agent decides whether it has enough evidence.

**Required repair**

Name the completed layer:

```text
[scip-query transport complete; evaluate command coverage separately]
```

Keep the continuation command and cursor protocol byte-compatible.

---

## 5. Refuted candidates

These observations were investigated and are not findings:

1. **Skill installation lacks target feedback — refuted.** `installSkills`
   already prints each installed, linked, skipped, and pruned target before
   its aggregate summary.
2. **Oversized JSON warning is accidentally duplicated — refuted.** The
   existing regression test requires two copies, and the ordering intentionally
   places one before and one after raw JSON so edge truncation cannot hide the
   only warning.
3. **TLA scaffold/instrument silently overwrite files — refuted.** Both refuse
   existing output unless `--force` is explicit and then list written paths.
4. **Setup-CI silently overwrites workflows — refuted.** It refuses an
   existing workflow without `--force` and exposes `--dry-run`.
5. **Watcher lifecycle flags can be combined — refuted.** The handler already
   rejects more than one of `--daemon`, `--status`, and `--stop`.
6. **Human pagination can end mid-line — refuted for ordinary output.** The
   snapshot writer prefers newline boundaries for human pages and tests prove
   continuation pages begin on complete rendered lines.
7. **Suppression replacement can silently clobber another decision —
   refuted.** Replacement requires the reported SHA-256 revision and fails on
   a concurrent change.

---

## 6. Remediation acceptance

The interaction remediation is complete only when:

- all twelve findings have focused regression coverage;
- destructive uninstall requires explicit real scope;
- project-hook removal does not evaluate installation identity;
- default uninstall output names every changed target without enumerating
  every unchanged personal skill;
- guided setup never silently degrades into automatic selection;
- hook-removal modes are previewable and mutually exclusive;
- no watch timing flag can be accepted and ignored;
- partial index publication is unmistakable in human output;
- init and agent setup render outcomes derived from actual writes/skips;
- suppression success states scope and lifetime;
- cleanup application has a same-plan, non-writing preview with exact targets;
- human pagination distinguishes transport completion from command coverage;
- generated command documentation and affected skill examples match the
  changed flags and semantics;
- focused tests, the full suite, typecheck, lint, build, public API checks,
  `diff-impact`, and `diff-gate` pass or every surviving gate finding has a
  written evidence-backed disposition.
