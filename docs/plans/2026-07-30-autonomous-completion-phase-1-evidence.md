# Phase 1 — evidence foundation

Date: 2026-07-30
Status: ready for execution
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
