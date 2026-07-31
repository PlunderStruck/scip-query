# Phase 1 — evidence foundation

Date: 2026-07-30
Status: in progress — slices 1.1–1.3 complete; slice 1.4 next
Parent: [Autonomous completion execution plan](./2026-07-30-autonomous-completion-execution.md)

## Goal

```gherkin
Feature: Honest, composable evidence for every machine-readable operation

  Scenario: A repository observation is reused
    Given two results whose receipts establish the required state relationships
    When product policy evaluates their evidence for one claim
    Then each required relationship and claim qualification is established independently

  Scenario: A mutation emits JSON
    Given a command mode that changes repository or shared project state
    When it emits a machine-readable result
    Then it is named as a mutation and does not inherit observation authority by default

  Scenario: A legacy receipt is read
    Given a valid version-1 observation receipt
    When current code decodes it
    Then its facts remain readable and every unproved version-2 relationship remains unknown
```

## Concepts fixed by this phase

An operation role is a finite classification of what one parsed command
invocation does to or learns about the world. Its referents are invocations
that observe repository state, preview a change, mutate state, combine those
effects, inspect the execution environment, or describe the tool itself. It is
wider than a command name because one command can have several modes; the
causal distinction is the invocation's externally observable effect.

An observation receipt is an immutable factual record of the state sources one
operation actually held and the mechanism that kept them stable while reading.
It is wider than a content hash: the differentiating fact is that it names
independent collaboration, workspace, content, input, generation, and stability
referents so policy can compare them without inventing a single false identity.

A claim qualification is one independent property of a result that determines
what conclusions or actions it can support. Its referents are origin,
enumeration coverage, producer validation, observed-state authority, and action
permission. It is wider than the current evidence tier; its differentiating
property is composability, so weakness in one dimension does not erase or
silently strengthen another.

## Current code path and reuse

- `CommandDescriptor.agent` is the generated source for all 93 public
  agent-facing command contracts, but it currently describes questions,
  inputs, result units, and coverage—not operation effect.
- `printJsonEnvelope()` in
  `src/runtime/command-kit/command-execution.ts` is the shared 113-consumer JSON
  seam. It already receives parsed positional arguments and options.
- `CliJsonEnvelopeV1` and the public JSON schema are additive compatibility
  boundaries.
- `ObservationReceipt` and `buildObservationReceipt()` already serve stop-hook,
  outcome-ledger, session-state, and JSON-envelope consumers.
- `ProjectInputSnapshot`, generation metadata, `GitWorktreeContext`, and
  revision-aware immutable artifacts already provide most raw referents.

Reuse those boundaries. Do not add a second renderer, a command-name switch in
the renderer, a second receipt family, or an agent-authored provenance file.

The initial `plan-context` pass was bounded to the highest-priority 2,500
candidates. It found 113 external consumers for the shared execution module
and identified command handlers, query-command modules, envelope tests, API
reports, and pagination as the immediate surface. Before editing the shared
seam, run the unbounded pass and preserve every emitted transport page.

## Slices

### 1.1 Descriptor-owned operation roles

Anchor and current behavior:

- `CommandAgentContract` has no operation classification.
- `printJsonEnvelope()` cannot distinguish an observing result from a preview,
  mutation, composite, environment observation, or tool-information result.

Exact change:

- add a closed `CommandOperationRole` union and a typed selector over parsed
  arguments/options to the descriptor contract;
- resolve the selected role before handler execution and carry it through the
  command runtime context;
- generate a complete role registry for every public operation;
- add `operationRole` to the JSON envelope and evidence context; and
- reject public descriptors with missing or unreachable role selections.

Validation and expected result:

- descriptor contract test enumerates every public operation and reports zero
  missing roles;
- table tests prove at least one fixed and one mode-selected command role;
- mutation fixtures for setup, suppress, baseline writing, and TLA writing do
  not report repository observation;
- legacy envelope decoding remains supported; and
- public schema/API compatibility classifies the fields as additive.

Testability:

- selection is a pure function of parsed invocation values;
- command integration tests assert the emitted role, not internal selector
  calls.

Order rationale:

- receipt construction depends on knowing what was observed or changed, so the
  role must exist before receipt v2 is attached.

### 1.2 Receipt v2 fact model and legacy decoder

Anchor and current behavior:

- `ObservationReceipt` version 1 combines path-derived project identity,
  optional index/worktree facts, and a coarse authority kind.
- `compareObservationReceipts()` returns one compatibility boolean and loses
  independent relationship uncertainty.

Exact change:

- introduce a version-2 discriminated union while retaining the v1 reader;
- record independent collaboration-domain, workspace-instance,
  whole-content, relevant-input, index-input, immutable-generation, observed
  source, and stability-proof facts;
- give every identity a projection/schema version and canonical hash algorithm;
- return named `established | disproven | unknown` judgments with reasons for
  each relationship;
- derive state authority in one versioned product-policy function; and
- migrate v1 records only into facts they genuinely contain.

Validation and expected result:

- identical content in separate clones establishes content equality while
  workspace equality is disproven or unknown;
- shared worktrees establish collaboration equality without implying content
  equality;
- unknown differs from disproven and satisfies no required completion
  relationship;
- v1 fixtures decode and receive no synthetic collaboration/content/stability
  proof; and
- comparison is symmetric for symmetric relationships.

Testability:

- canonical identity, comparison, and authority derivation are pure domain
  functions;
- filesystem/Git snapshot collection is tested at the adapter boundary with
  real temporary repositories.

Order rationale:

- comparison and policy must be correct before any result can claim the new
  receipt is authoritative.

### 1.3 Fixed snapshot and index alignment

Anchor and current behavior:

- ordinary queries hold an immutable generation but do not prove that it
  represents the current fixed repository inputs;
- the stop hook has a lease plus before/after worktree identity, which is
  lower authority than observing one immutable snapshot.

Exact change:

- persist the versioned index-input identity with each immutable generation;
- construct repository whole-content and relevant-input identities from one
  fixed input snapshot;
- compare the generation's stored index-input identity to the same projection
  computed from that snapshot;
- represent leased before/after equality as an explicit weaker stability proof;
  and
- cache identities only for an interval whose snapshot identity is unchanged.

Validation and expected result:

- a matching generation/input projection establishes index alignment;
- untracked source, configured ignored input, config, and deleted-file cases
  alter the correct identities;
- unrelated content may preserve a certified relevant-input identity without
  preserving whole-content identity;
- a mid-read mutation yields unknown stability or retries; and
- automatic query overhead stays inside the pre-registered slice guard.

Testability:

- snapshot-to-identity projection is pure;
- race fixtures mutate a real temporary repository between adapter checkpoints.

Order rationale:

- claim metadata must not describe state authority until this phase can
  establish the underlying observation facts.

### 1.4 Composable claim metadata

Anchor and current behavior:

- `CommandEvidenceTier` compresses provenance into
  `graph-fact | heuristic | mixed`;
- coverage is already separate, but validation, state authority, and action
  permission are not explicit.

Exact change:

- replace the internal coarse claim model with independent origin, coverage,
  producer-validation, state-authority, and repository-policy action fields;
- preserve top-level `evidence` during an additive compatibility window;
- let mixed commands attach provenance to result families or rows;
- generate schema/docs/API tables from the descriptor registry; and
- make completion consumers name the qualification predicates they require.

Validation and expected result:

- a complete heuristic scan remains complete without becoming graph-derived;
- a graph result over a stale or unstable state remains graph-derived without
  becoming completion-authoritative;
- an authoritative finding remains non-actionable when repository policy says
  advisory; and
- registry, docs, runtime, and schema enumerate the same closed values.

Testability:

- qualification derivation is a pure function over receipt comparison,
  manifest, validation, and policy inputs.

Order rationale:

- this closes the evidence foundation consumed by durable state and completion.

## Execution record

### Slice 1.1 — descriptor-owned operation roles

Implemented:

- every public command descriptor now owns a closed operation selector over
  parsed arguments and options;
- the registry selects the role before handler execution and binds it through
  concurrent async execution;
- the shared JSON renderer verifies that the role did not change, emits it at
  the envelope boundary, and attaches repository observation context only to
  observation, preview, and composite roles;
- value-bearing options such as `--profile-out <path>` use an explicit
  presence selector rather than being mistaken for booleans;
- the decoder accepts legacy envelopes, validates known roles, and rejects
  contradictory top-level and nested roles;
- the JSON schema, CLI guide, generated agent-contract catalog, and public API
  acceptance record describe the additive contract; and
- runtime structure explicitly owns `command-operation.ts` in the
  `runtime-services` boundary, which both command-kit and runtime-entry are
  already permitted to consume.

Observed verification:

- 85 focused descriptor, renderer, envelope, pagination, and real CLI process
  tests passed, followed by all 2,198 repository tests across 273 files;
- typecheck, build, lint, generated-doc checks, and public API consumer checks
  passed;
- API change `f5bc118615a4a4f9` was accepted as additive;
- scoped architecture reported no declared boundary violations after the
  ownership correction;
- health remained at the pre-registered 96 older baseline deltas, with no new
  wrapper residue;
- `stats --json --compact` measured 261.4 ms median across nine warm runs,
  7.4% above the nearest 243.3 ms baseline and inside the 20% / 292.0 ms guard;
  and
- `diff-gate` passed with one advisory historical doc citation and three
  content-invalidated coupling decisions replaced by specific, evidence-bound
  shared suppression records.

Refutation attempts:

- a value-bearing `profileOut` option selects `composite`, proving mutation
  classification does not depend on comparing every option to `true`;
- a role selected as `mutation` and re-resolved as
  `repository-observation` is rejected before rendering; and
- a synthetic `suppress` result emits `mutation` without an
  `evidenceContext`, proving mutation output does not inherit observation
  authority.

Deviation:

- the first implementation placed the operation vocabulary under the broad
  `domain` boundary. The architecture gate rejected
  `runtime-command-kit -> domain` and `runtime-entry -> domain`. The contract
  was moved to the existing `runtime-services` boundary because its referents
  are CLI invocation effects, not repository-domain entities; no dependency
  allowance or architecture baseline was weakened.

### Slice 1.2 — receipt v2 fact model and legacy decoder

Implemented:

- the receipt is now a v1/v2 discriminated union; v1 values retain their
  historical fields and decode as legacy facts without acquiring stronger v2
  meanings;
- v2 records collaboration domain, repository lineage, workspace instance,
  whole content, relevant inputs, index inputs, immutable generation, observed
  sources, and stability proofs as independent optional facts;
- every content-derived identity binds its projection name/version,
  canonicalization version, hash algorithm, and digest;
- comparisons return named three-valued judgments with the facts and reasons
  supporting each relationship; there is no replacement universal
  compatibility boolean;
- one versioned policy function derives completion, advisory, or no state
  authority at consumption time and requires collaboration, whole-content,
  fixed-observation, and applicable index-alignment facts;
- the decoder rejects contradictory source identities and impossible
  proof/source pairs, preventing a producer from labeling a live workspace
  immutable;
- `.scipquery.json` now owns one committed collaboration-domain UUID. `init`
  and `setup` add it through the existing revision-aware writer, preserve a
  concurrent winner, and never rotate an established identity;
- CLI envelopes, suppression records, outcome events, and project config refer
  to one packaged observation-receipt schema instead of retaining duplicated
  receipt definitions; and
- README, CLI output, configuration-safety, and committed-record guidance
  define clone/fork inheritance, unknown facts, legacy behavior, and central
  authority derivation.

Observed verification:

- 167 focused receipt, config, setup, envelope, durable-record, outcome, and
  real CLI-process tests passed, followed by all 2,208 repository tests across
  273 files;
- typecheck, build, lint, generated-skill-link checks, config validation, and
  the public API consumer passed;
- API change `6be15204f820b83c` was accepted as breaking because retaining the
  v1 aggregate comparison boolean would preserve an unsound completion
  inference; the v1 wire decoder remains supported;
- fresh `diff-impact` found 81 changed symbols and 19 downstream consumer
  files, matching receipt, config, setup, storage-record, renderer, and public
  API consumers;
- complete architecture output reported no declared boundary violations;
  unbounded recent-duplicate and unused-parameter scans found none;
- the unbounded stale-abstraction scan reported four older single-consumer
  types, including the unchanged `ResolvedWatchConfig` declaration in an
  edited file, but no type introduced by this slice;
- the full documentation scan was transported to completion. Current receipt,
  config, CLI, compatibility, and README guidance was updated; remaining
  results were historical snapshots or broad co-change signals rather than a
  contradictory current receipt claim;
- final `diff-gate` passed with zero findings after four detector
  counterexamples were recorded as shared, evidence-bound decisions: one
  unrelated closed-vocabulary predicate match and three historical co-change
  pairs whose command-layer contracts did not change;
- health-baseline comparison exposed two new heuristic signals from this
  slice: the cohesive v2 decoder as an extraction candidate and a trivial
  source-kind membership predicate matching an unrelated enum predicate.
  Neither represents duplicated domain behavior or an earned reusable
  abstraction; and
- `stats --json --compact` measured 286.5 ms median across a second set of nine
  isolated warm runs, 17.8% above the 243.3 ms preregistered baseline and
  inside the 20% / 292.0 ms guard. The first set measured 291.4 ms and also
  remained inside the guard.

Refutation attempts:

- two v2 receipts with equal collaboration and whole-content identities but
  different workspace-instance identities establish reusable content without
  equating clones;
- a receipt with a source identity contradicting its fact, or with an
  `immutable` proof over a live workspace, is rejected as malformed;
- bracketed live-workspace equality remains advisory even when content
  identities match, because endpoint equality cannot prove there was no
  intermediate mutation; and
- a valid v1 pair can establish only equal legacy generation values; its
  collaboration, workspace, content, and stability relationships remain
  unknown.

Deviation:

- the planned fixed whole-content and index-input facts exist in the v2
  vocabulary but ordinary producers deliberately leave them absent in this
  slice. Slice 1.3 will compute both from one fixed snapshot; emitting a
  convenient live-worktree hash here would have manufactured authority before
  the required stability mechanism exists.

### Slice 1.3 — fixed snapshot and index alignment

Implemented:

- a fixed project observation snapshot now uses the immutable Git tree as its
  base and captures dirty, untracked, deleted, executable-mode, symlink, and
  explicitly configured ignored-input overlays before analysis; non-Git and
  unborn repositories use a bounded in-memory snapshot;
- repository-content identity is clone-independent and includes committed
  suppressions while excluding derived artifacts, machine-local state,
  outcome-event history, and repository-declared historical snapshot paths;
- project reads, listings, and fingerprints can run inside an async-local
  snapshot context, so concurrent commands cannot see each other's bytes and a
  deletion remains a tombstone instead of falling back to the live filesystem;
- the versioned relevant-input projection is computed from the same snapshot,
  including an explicitly configured ignored input that ordinary Git file
  enumeration would omit;
- the immutable generation's existing metadata fingerprint is decoded into the
  same versioned identity only when a fixed-snapshot producer needs alignment;
  no redundant persisted identity field was added; and
- receipts supplied with that snapshot state the whole-content identity,
  relevant-input identity, stored generation-input identity, immutable
  generation source, and fixed-snapshot proof independently. Capture failure
  yields no such fact.

Observed verification:

- focused snapshot, project-file, and receipt tests prove clone-independent
  identities, exact generation alignment, ignored configured inputs,
  executable modes, symlinks, deletion tombstones, post-capture live edits,
  concurrent isolation, and fail-closed mid-capture mutation;
- the identity fast path is byte-for-byte compatible with the version-1
  canonical preimage, and the project-input fast path equals the generic
  recursively stable encoding;
- all 2,214 tests across 274 files passed; typecheck, build, lint, formatting,
  generated skill-link checks, and the unchanged 72-path public API contract
  passed;
- fresh `diff-impact` found 55 changed symbols and 14 affected consumer files;
  complete architecture transport reported no declared boundary violations,
  and unbounded recent-duplicate and unused-parameter scans found none;
- `diff-gate` passed with one advisory same-name error-predicate signal whose
  other implementation handles affected-shadow filesystem races rather than
  fixed-snapshot capture; and
- `stats --json --compact` measured 285.2 ms median across nine isolated warm
  runs, inside the pre-registered 292.0 ms guard.

Refutation attempts:

- mutating a source file at the adapter's validation boundary invalidates the
  snapshot instead of returning a bracketed or fixed proof;
- two simultaneous async snapshot contexts read different fixed bytes without
  cross-command contamination;
- deleting a tracked file leaves a fixed missing-path tombstone and cannot
  expose a replacement created later; and
- an ignored but configured TypeScript project input changes both repository
  content and relevant-input projections.

Deviation:

- the first integration captured a repository snapshot for every ordinary
  repository-observation command. It measured 398.9 ms median on the
  pre-registered `stats` path and falsely implied that every producer consumed
  repository bytes. The replacement keeps snapshot construction scoped to
  producers that declare and actually read that source. Slice 1.4 owns that
  declaration and qualification registry. Graph-only commands therefore pay no
  snapshot ceremony and retain unknown whole-content alignment until a
  completion consumer requests a producer that establishes it.

## Verification gate

Run focused domain, descriptor, envelope, pagination, stop-hook, generation,
and API tests; typecheck; build; lint; API compatibility; the same warm timing
benchmark; receipt-related cleanup checks; and `scip-query diff-gate`.

## Risks and deferrals

- Cross-host collaboration identity needs a committed repository referent. If
  no existing project record can safely own it, add one explicit generated ID
  through setup; do not use a mutable remote URL as proof.
- Whole-content identity must not absorb caches, secrets, or machine state.
  Its inclusion policy is versioned and repository-relative.
- Relevant-input identity is claim-specific. Phase 1 may ship whole-content
  authority first and retain narrower reuse as unknown until a producer
  declares a sound projection.

## Handoff probe

Before Phase 2 starts, a test must construct two results from two workspace
instances and decide—without reading absolute paths—exactly which facts can be
combined for one completion claim.
