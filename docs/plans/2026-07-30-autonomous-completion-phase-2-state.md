# Phase 2 — durable autonomous state

Date: 2026-07-30
Status: complete — slices 2.1–2.4 implemented and verified; Phase 3 is next
Parent: [Autonomous completion execution plan](./2026-07-30-autonomous-completion-execution.md)

## Goal

```gherkin
Feature: Autonomous work survives interruption without losing its reason or history

  Scenario: An agent resumes after compaction or process death
    Given an authorized goal with attempts, decisions, and live obligations
    When a supported agent session is restored
    Then it receives the current goal and the minimum state needed to continue without repeating settled work

  Scenario: Two branches contribute records
    Given separate attempts derived from one intended change
    When both branches merge
    Then immutable records compose without one writer silently erasing the other

  Scenario: An action is retried after an unknown outcome
    Given a prior attempt whose effect may have occurred
    When the agent resumes
    Then the system preserves the unknown outcome and prevents an unsafe duplicate effect
```

## Concepts fixed by this phase

An intended change is one mergeable body of repository work authorized by one
goal. Its referents are the plan, attempts, temporary decisions, and
obligations that travel with a feature branch or pull request. It is wider than
a process session and narrower than permanent project history; the
differentiating fact is that its identity survives branch movement and
collaborative merge until the change is completed or abandoned.

An attempt is an immutable record of one purposeful action and its observed
effect. It is wider than a command log entry because it names the condition the
action tried to move; the distinguishing property is causal continuity, which
lets a later agent distinguish a new strategy from repetition after context
loss.

A completion obligation is a durable, current requirement that must be
reconciled before the intended change may complete. Its referents are affected
tests, docs, residue, architecture edges, migrations, and other consequences
admitted by declared policy. It is wider than a detector finding; the
distinguishing fact is an explicit lifecycle that remains live until evidence
fulfills it, invalidates its premise, or carries it atomically to a successor.

## Current code path and reuse

- `agent-session-state.ts` persists one 24-hour, process-session restoration
  record with the latest stop receipt and unfinished paginated output.
- `revisioned-file.ts` already serializes cooperating writers without lost
  updates.
- `.scipquery/events/*.json` and `.scipquery/suppressions/*.json` already
  demonstrate mergeable immutable shared records.
- generation stores and outcome ledgers already use atomic publication,
  compatibility readers, and bounded retention.

Do not expand the short-lived session cache into the canonical project ledger.
Reuse its restoration adapter to point at canonical shared records.

## Slices

### 2.1 Goal and intended-change identity

Anchor and current behavior:

- no canonical goal exists outside prose plans and prompts;
- session identity and absolute project path do not survive clone or branch
  collaboration.

Exact change:

- add a versioned committed goal record under `.scipquery/goals/`;
- store one concise Gherkin feature, invariant rules, acceptance scenarios,
  authorization metadata, collaboration domain, and immutable goal identity;
- add an intended-change record under `.scipquery/changes/` that references the
  goal and uses an opaque stable ID rather than branch name; and
- expose create/read/validate/status operations that are idempotent and
  scriptable.

Validation and expected result:

- formatting-only or metadata-only edits do not silently change goal identity;
- a semantic goal revision creates a successor rather than overwriting
  history;
- two clones read the same committed goal/change identity; and
- malformed, future, and legacy versions receive explicit compatibility
  outcomes.

Implementation decisions fixed before editing:

- one goal record represents one immutable semantic goal version. Its identity
  is the SHA-256 digest of normalized Gherkin meaning plus the committed
  collaboration domain; whitespace-only and writer/timestamp changes are not
  new goal versions, while a feature, invariant, or acceptance-scenario change
  is;
- a semantic revision is a new goal record naming its predecessor. Existing
  goal bytes are never updated in place;
- one intended-change record represents one mergeable body of work, independent
  of process, branch, worktree, or clone. Its opaque identity is derived from a
  caller-originated idempotency key scoped to the collaboration domain; a retry
  with the same meaningful request returns the existing record, while reuse
  with different content is an integrity error;
- create publication reuses durable, exclusive single-file publication. The
  filesystem's exclusive link is the uniqueness constraint; no
  check-then-create preflight is treated as authoritative;
- `goal` and `change` CLI operations expose `create`, `read`, `validate`, and
  `status`. Creation accepts one bounded JSON request file and derives record
  identity, writer metadata, timestamp, path, and collaboration facts
  automatically; and
- the committed record directories are canonical. Human output, JSON
  envelopes, session restoration, and later current-state folds are derived
  views rather than second stores.

Implemented result:

- canonical program goal:
  `SQG-4061E7D5D360464ED8E8B05D53BBF49D`;
- canonical intended change:
  `SQC-DED67E74D3898BDCA85766BE8D3C93AF`;
- the executable created both records durably, reused the goal on retry,
  validated it by repository path, and reported one complete goal/change set;
- focused domain, storage, setup, uninstall, and CLI-contract checks passed
  64 of 64, including the linked-but-unacknowledged unknown-outcome case;
- the storage contract covers canonical identity, semantic successor links,
  same-key collision, linked-but-unacknowledged retry recovery, forward-version
  classification, non-symlink reads, and additive two-branch composition;
- formatting, lint, the 72-path public API contract, and all 2,236 tests in 277
  files passed;
- a fresh compiler-resolved index found no architecture violation, the scoped
  diff gate passed over 7 changed source files and 106 symbols, and an
  out-of-repository validation path was rejected; and
- the repository-wide health baseline remains red with 113 accumulated
  Phase 0–2 heuristic deltas. That broad backlog is not treated as evidence
  against this slice: the changed-surface gate is clean, and the two new
  single-consumer record contracts remain deliberate serialized boundaries for
  the remaining Phase 2 slices.

### 2.2 Append-only attempts and decisions

Anchor and current behavior:

- outcome events are immutable, but agent actions and why a strategy changed
  are not durably connected to the goal.

Exact change:

- add immutable attempt and decision records keyed by opaque event IDs and
  idempotency keys;
- record intended condition, action family, consumed evidence receipts,
  observed effect, outcome `succeeded | failed | unknown`, and successor
  decision;
- publish with create-if-absent semantics; and
- derive current summaries by folding immutable records in deterministic order.

Validation and expected result:

- replaying one idempotency key creates no duplicate effect record;
- concurrent writers preserve both distinct records;
- an unknown action outcome remains unknown until reconciled by current
  observation; and
- merging branches with distinct attempts is conflict-free by filename.

Implemented result:

- attempt records use `SQA-...` identities and decision records use `SQD-...`
  identities derived from collaboration-scoped caller idempotency keys, with
  separate request digests that bind their complete meaning;
- both record families use the durable exclusive publication seam shared with
  goals and intended changes, so retries recover a linked-but-unacknowledged
  publication and same-key semantic drift fails as an integrity error;
- the deterministic history fold orders by timestamp and opaque identity,
  retains unresolved unknown outcomes, marks unresolved non-idempotent actions
  unsafe to repeat, and exposes conflicting terminal reconciliations instead
  of choosing a last writer;
- a terminal reconciliation requires a supported version-2 observation
  receipt observed at or after the unknown attempt, and `retry-safe` decisions
  cannot use an unresolved non-idempotent basis;
- branch-composition tests keep distinct attempts and decisions from both
  branches, while status validates goal, intended-change, attempt, decision,
  and relationship compatibility together;
- the executable dogfood history contains implementation attempts
  `SQA-C1F519DED08E91C766F719FA00C2D603` and
  `SQA-7C59A62D596039935252632AC66325A0`, followed by completion-candidate
  decision `SQD-B000B29DF89059251CC82AFB3CF85722`;
- focused work-ledger, CLI, setup, and uninstall checks passed 63 of 63;
  formatting, lint, build, the unchanged 72-path API contract, and all 2,248
  tests in 279 files passed; and
- a fresh compiler-resolved index established the domain-fold-to-storage-to-CLI
  consumer path, found no architecture violations, no recent
  reimplementations, and no unused parameters. The final diff gate passed over
  8 changed source files and 103 symbols after renewing the existing
  content-bound adjudication that the dedicated work-state handler—not the
  legacy command monolith—owns these descriptors.

### 2.3 Obligation lifecycle

Anchor and current behavior:

- findings and suppressions persist, but no shared lifecycle connects a
  consequence to one intended change.

Exact change:

- add immutable obligation admission and transition records;
- use a closed lifecycle:
  `live -> fulfilled | invalidated | carried-forward`;
- require current evidence and reason codes for every terminal transition;
- derive current obligation state from the event fold; and
- reject terminal-to-live resurrection except through a new obligation.

Validation and expected result:

- no live obligation disappears through overwrite, merge order, or compaction;
- unknown evidence cannot close an obligation;
- carry-forward creates the successor and closes the predecessor atomically in
  one transition record; and
- terminal conflicts are exposed rather than resolved by last-writer-wins.

Implemented result:

- admission records under `.scipquery/obligations/` use `SQO-...` identities,
  transition records under `.scipquery/obligation-transitions/` use `SQT-...`
  identities, and both derive stable filenames from collaboration-scoped
  caller idempotency keys while binding complete meaning through a separate
  request digest;
- the deterministic fold starts every admitted obligation at `live`, accepts
  only the closed terminal states and controlled reason codes above, never
  resurrects a terminal obligation, and reports incompatible terminal
  meanings as conflicts instead of choosing by timestamp or merge order;
- terminal transitions require supported version-2 observation receipts from
  the same collaboration domain, observed after admission, with fixed
  repository-source proofs and whole-content identity. Future, stale,
  moving-workspace, and wrong-domain receipts fail closed;
- a carried-forward transition embeds the complete successor obligation and
  derives its identity from the transition, so the predecessor closure and
  successor admission cannot split across branches or crashes;
- storage validates goal, intended-change, attempt, obligation, transition,
  and cross-record relationships together. Any incomplete compatibility or
  integrity view prevents terminal publication rather than hiding unreadable
  work;
- `obligation admit|transition|read|validate|status` exposes the lifecycle to
  agents, setup and uninstall own both committed record directories, and the
  agent contract now requires these records to travel with the code or docs
  change that produced them;
- domain and storage tests cover retry recovery, same-key collision, partial
  and future records, stale and unstable evidence, concurrent branch
  transitions, explicit conflicts, atomic carry-forward, scoped successor
  visibility, and terminal non-resurrection;
- the shared immutable work-record envelope now validates kind, version,
  collaboration domain, timestamp, and writer once for goals, intended
  changes, attempts, decisions, admissions, and transitions without merging
  their distinct meanings; and
- formatting, lint, build, the 72-path public API contract, and all 2,261 tests
  in 281 files passed. A fresh compiler-resolved index found no declared
  architecture violation, recent reimplementation, unused parameter, or
  incomplete migration; the changed-surface diff gate passed after renewing
  the content-bound decision that the dedicated work-state handler owns these
  commands.

### 2.4 Restoration projection

Anchor and current behavior:

- post-compaction context restores pagination and the latest stop attempt only.

Exact change:

- project the canonical goal/change ledger into a bounded restoration summary;
- include current goal, last distinct failed/unknown attempts, settled
  decisions, live obligations, and exact continuation commands;
- record a summary cursor so unchanged state is not repeated at every hook;
  and
- preserve links to full records rather than truncating their meaning.

Validation and expected result:

- a restored agent can state the goal, current condition, last attempted
  strategy, and every live obligation without transcript access;
- the summary stays within a pre-registered byte/token budget; and
- unchanged hooks add no repeated context.

Implemented result:

- a deterministic restoration projection folds committed goals, intended
  changes, attempts, decisions, admissions, and transitions without promoting
  the 24-hour session cache into a canonical store;
- active changes retain their governing Gherkin goal, intended outcome,
  current condition, latest strategy, latest settled decision, unresolved
  non-idempotent effects, the latest still-unsuccessful attempt in each action
  family, and every live obligation;
- abandoned changes disappear only after no live obligation, unresolved
  unknown effect, or reconciliation conflict remains. Completion-candidate
  changes stay active until Phase 3 supplies an independently protected
  completion transition;
- all six work-record collections are read once for the projection. Their
  compatibility and relationship failures make it explicitly unverified
  instead of allowing the readable subset to masquerade as complete history;
- rendering is pre-registered at 16 KiB of UTF-8 hook context. Overflow emits
  complete change identities and exact `goal`, `change`, `attempt`,
  `decision`, and `obligation` status commands rather than truncating record
  meaning;
- `SessionStart` reconstructs purpose from committed records without any
  transcript, while `PostCompact` combines the same durable projection with
  unfinished output and the last Stop receipt;
- session-cache schema 2 atomically records the projection cursor, complete
  rendered-evidence cursor, and stable hook-event digest under the existing
  revision-aware lock. Identical compaction callbacks are suppressed; changed
  work facts, session evidence, or compaction epochs are delivered; and an
  unavailable transcript digest favors safe redelivery;
- focused domain, storage, session-state, and hook tests passed 29 of 29,
  including fresh-process recovery, superseded-failure removal, unsafe retry
  retention, live-obligation recovery, malformed-record failure, budget
  overflow, and duplicate compaction delivery; and
- all 2,268 tests in 283 files passed, together with typecheck, formatting,
  lint, build, the unchanged 72-path public API contract, doctor,
  architecture, recent-duplication, incomplete-migration, unused-parameter,
  dead-code, documentation, and scoped health checks;
- fixed-snapshot verification attempts
  `SQA-94C510F964AE68ADC2D7DD6DAF6EE8B9` and
  `SQA-283B608E2DF954FF101445F6FD59943C` establish the behavior before and
  after the final canonical-ordering reuse and detector reconciliation; and
- obligation `SQO-E74312A179E0DB48E9AA78F8F9F8E62F` is fulfilled by transition
  `SQT-95D3845A2388AAF64748320F1A78510C`, so Phase 2 closes with no live
  obligation hidden by the projection.

## Durability and concurrency gate

Before implementation, load the durability, concurrency, and distributed-data
lenses. Test atomic publish, crash before/after rename, partial files,
duplicate delivery, stale readers, concurrent distinct writers, same-ID
collision, branch merge, and forward-version handling.

The canonical source is the append-only shared record set. Session cache,
rendered summary, and derived current state are reconstructable projections.

## Risks and deferrals

- Git cannot make two writers choose the same filename conflict-free. Opaque
  random event IDs and create-if-absent publication make collisions
  negligible; a collision with different content is an explicit integrity
  error.
- Goal authorization identity may initially be a repository-local delegation
  record rather than a cryptographic human signature. Phase 3 protects its use
  during evaluation; stronger signing is deferred until a real trust boundary
  requires it.

## Handoff probe

Kill an agent after recording an action with an unknown outcome, resume in a
fresh process, and prove that the next autonomous decision neither repeats the
unsafe action nor asks a human to restate the goal.
