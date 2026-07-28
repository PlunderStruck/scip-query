# Design-by-Contract Remediation Plan

Date: 2026-07-27
Baseline revision: `8745d26dc3d10213d74e8d0f370b36d1e178c496`
Audit: `docs/reviews/2026-07-27-design-by-contract-audit.md`
Mode: high assurance
Status: approved for execution

## Goal

Close DBC-01 through DBC-09 without hiding operational failure behind an
ordinary empty result, without changing valid CLI wire representations, and
without abruptly removing an existing public package entry point.

The work is complete only when a caller can distinguish every expected
alternative, every resource owner retains authority until its obligation is
discharged, invalid protocol combinations fail at the type or decoder
boundary, and every negative path has an observable-behavior test.

This plan deliberately does not edit `skills/**`. Claude owns concurrent
skill changes. Source, tests, generated public API artifacts, command
documentation, this plan, the audit, and exact verification records are in
scope.

## Definitions and invariants

A **durable settlement** is a storage transition that moves a claimed mailbox
request into a completed or rejected record before the live service accepts
replacement work. The causal fact that distinguishes settlement from an
in-memory callback is that a later process can observe the terminal record
after the current process exits.

An **evidence result** is a command result paired with a machine-readable
account of which required discovery operations succeeded. The fact that makes
it evidence rather than a best-effort observation is that failure to perform a
required operation cannot be represented as an ordinary empty answer.

An **availability result** is a tagged outcome that distinguishes a known
answer from inability to establish that answer. The tag determines the fields
that must exist, so a consumer cannot accidentally treat operational failure
as absence.

A **resource owner** is the object whose methods are the only supported way to
release or mutate an acquired resource. Ownership is present only when the
object retains authority from acquisition through every successful,
exceptional, and repeated-close path.

A **compatibility wrapper** is a retained public entry point that translates
an older call shape into a new explicit result or named-options API. It
preserves valid existing calls while making the safer API primary; it does not
preserve silent failure or contradictory states.

The following invariants govern every slice:

1. A claimed mailbox request is never forgotten while its durable owner is
   still live and no terminal record exists.
2. Safety and evidence discovery failures remain tagged failures through every
   caller and renderer.
3. `complete: true` means the invocation returned the complete result set:
   `totalKnown` is true, `returned === total`, no results are omitted, and no
   continuation exists.
4. Historical absence means Git successfully established that a path did not
   exist at the resolved base; Git unavailability is a different outcome.
5. Every acquired SQLite connection and generation lease is released exactly
   once after any later initialization failure or normal close.
6. A public protocol tag selects exactly the fields that are valid in that
   state.
7. Expected symbol-resolution alternatives are returned as data. Exceptions
   remain reserved for violated preconditions or operational failures.
8. Semantically different primitive arguments have named roles at the primary
   public API.
9. Existing valid JSON encodings remain valid unless a versioned decoder
   rejects a state that was already contradictory.

## Premises

P1. `WorkerRequestLane.handleMessage` currently clears its active request
before invoking settlement callbacks, and the TypeScript mailbox adapter
currently clears its durable claim before writing the terminal filesystem
record.

P2. `watch-server.ts` currently records a mailbox fatal error but does not make
that error a stop condition.

P3. `verifyCleanupPlan` is the sole production producer of
`CleanupVerification`, and the cleanup query handler is its sole command
consumer.

P4. `diffImpact` and isolated diff-impact batching feed both the public impact
command and `diffGate`; therefore degradation must survive partial merging and
process serialization.

P5. Base-content readers are shared by diff-gate and incomplete-migration, so
the absence/error distinction must be introduced below both checks.

P6. `InvocationCoverage` is consumed by the common command execution layer.
Its type and runtime validator must change together, then every custom
coverage producer must compile and pass contract tests.

P7. Valid output-page, Worker, watcher, process-lock, and semantic-availability
wire objects already carry enough state to preserve their JSON representation
as discriminated unions.

P8. `ScipDatabase` is exported and widely consumed. Its raw `db` field is used
internally, but direct connection shutdown is not a supported query operation.
A read-only query port can preserve internal query use while removing
`close()` and `pragma()` from the public TypeScript surface.

P9. `methods` has one query implementation, one package-root re-export, and one
CLI descriptor. An additive resolution union can become primary while the
throwing array wrapper remains available.

P10. The high-risk positional helpers have a small number of compiler-resolved
call sites. Additive named APIs can be adopted internally before positional
wrappers are deprecated.

P11. The unbounded SCIP planning pass found no additional external production
consumer beyond the surfaces named above. The `ScipDatabase` result was
retrieved through every emitted transport page; its very broad consumer set is
why that slice requires full build and API validation.

## State-authority inventory

| State                    | Authoritative owner                                    | Acquisition                       | Release or transition                                          | Failure obligation                     |
| ------------------------ | ------------------------------------------------------ | --------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| Worker request           | `WorkerRequestLane.active`                             | `start()`                         | successful callback, terminal rejection, or joined termination | keep admission closed                  |
| Durable mailbox claim    | TypeScript mailbox lane `current` plus inflight record | `pollBoundedMailboxRequests`      | completed/rejected record or dead-owner reclamation            | retain claim or stop owner             |
| Watcher liveness         | watch loop                                             | service start                     | stop condition and final cleanup                               | mailbox fatal must stop                |
| Working-tree knowledge   | cleanup verifier                                       | bounded `git status`              | tagged `known` or `unavailable` result                         | unknown blocks by default              |
| Consumer evidence        | diff-impact tier result                                | semantic/source discovery         | tagged success or failure merged into final result             | required-tier failure blocks full gate |
| Historical content       | resolved Git base reader                               | base resolution plus batch lookup | `present`, `absent`, or `unavailable`                          | unavailable never becomes `null`       |
| Invocation completeness  | common command executor                                | command coverage producer         | validated coverage envelope                                    | contradictory state is rejected        |
| SQLite generation reader | `ScipDatabase`                                         | `openPublishedGeneration`         | wrapper `close()` or constructor rollback                      | release exactly once                   |
| CLI methods outcome      | methods resolver                                       | class selection                   | `matched`, `missing`, or `ambiguous`                           | JSON remains valid on every outcome    |

## Reuse and compatibility audit

- Reuse `WorkerRequestLane` and the existing bounded mailbox settlement
  operations; do not add a second queue.
- Reuse cleanup's `CleanupVerificationPolicy`, extending it with a separately
  named unknown-state override rather than overloading `allowDirty`.
- Reuse diff-impact partial batching and diff-gate's existing failed-closed
  decision point; add structured evidence status rather than a second gate.
- Reuse Git base resolution and `cat-file --batch`; add a result algebra around
  them rather than invoking Git independently per check.
- Reuse the common invocation-coverage validator as the central runtime
  enforcement point.
- Reuse existing state tags and wire field names when forming discriminated
  unions.
- Reuse `ScipDatabase.all()` and `get()` as the supported query boundary, with
  a restricted prepared-statement port only where existing internal queries
  need it.
- Reuse `resolveDefinitions` and source-method merging for structured methods
  resolution.
- Preserve the existing positional functions as deprecated wrappers during
  this release. Internal callers move to named APIs immediately.

## Testability decisions

- Tests assert admission, durable mailbox files, terminal results, CLI bytes,
  process exit codes, coverage envelopes, and released generation leases.
- The Git/process boundary receives a production-shaped runner interface so
  nonzero exit, timeout, signal, and output overflow are deterministic.
- Diff-impact evidence discovery receives a provider interface at the tier
  boundary. Tests fail each tier through the same call path production uses.
- SQLite opening/initialization receives a resource-factory interface only if
  real SQLite cannot induce the rollback branch. The interface is an embedder
  boundary, not a test-only flag.
- Compile-time fixtures use `@ts-expect-error` for invalid union states and
  ordinary imports for public API availability.
- No test asserts private fields or copies production algorithms into expected
  values.

## Remediation slices

### Slice 1 — DBC-01: owned mailbox settlement

Red test first:

- completion settlement throws;
- rejection settlement throws;
- the lane cannot accept replacement work;
- the watcher loop treats mailbox fatal as a stop condition;
- a later close joins the Worker before the live owner becomes reclaimable.

Implementation:

- keep `WorkerRequestLane.active` until the selected settlement callback
  returns successfully;
- keep the TypeScript mailbox `current` claim and busy marker until the
  terminal write returns successfully;
- make callback failure close admission and report fatal while retaining the
  active ownership needed by shutdown;
- make the watch loop stop after the first mailbox fatal;
- ensure shutdown rejection is attempted only after Worker termination and
  does not clear ownership before its durable write succeeds.

Verification:

- focused Worker lane, mailbox, and watcher-loop tests;
- `tsc`;
- SCIP `affected` or `refs` postcheck for the edited lane entry point.

### Slice 2 — DBC-02: fail-closed cleanup inspection

Red test first:

- nonzero Git status, timeout, signal, and output overflow produce
  `unavailable`;
- a successful checker cannot override unavailable worktree knowledge;
- `allowDirty` does not authorize unknown state;
- an explicit `allowUnknownWorkingTree` policy does.

Implementation:

- introduce `WorkingTreeInspection = known | unavailable`;
- retain the existing dirty-file arrays in serialized output for compatibility
  while adding the authoritative tagged inspection;
- use one bounded Git-status runner and sanitize its error message;
- make `cleanupVerificationFailures` block unavailable inspection unless the
  separately named override is selected;
- render the reason in human and JSON output.

Verification:

- focused cleanup plan and handler tests;
- public/API typecheck where exported;
- SCIP consumer check for `CleanupVerification`.

### Slice 3 — DBC-03: structured evidence-tier degradation

Red test first:

- semantic consumer discovery fails;
- source fallback discovery fails;
- partial merging retains each failure;
- full diff-gate reports failed-closed coverage instead of complete coverage.

Implementation:

- represent each required consumer tier as `complete | failed` with a bounded
  reason;
- return both discovered rows and tier status from the safe discovery helper;
- merge tier states across isolated batches, where any failure dominates;
- expose the state in diff-impact JSON and rendering;
- make required-tier failure a gate execution failure, while retaining any
  successful findings for diagnosis.

Verification:

- diff-impact accuracy, isolated report, CLI, and diff-gate tests;
- full retrieval of any paginated command output;
- documentation for the additive JSON fields.

### Slice 4 — DBC-04: historical content result algebra

Red test first:

- present path returns content;
- genuinely absent path returns `absent`;
- invalid base, Git failure, timeout, or malformed batch returns
  `unavailable`;
- diff-gate and incomplete-migration fail closed or report skipped evidence
  rather than treating unavailable as absence.

Implementation:

- add named strict base-content APIs returning
  `present | absent | unavailable`;
- resolve the base once and preserve batch identity;
- migrate diff-gate and incomplete-migration to the strict reader;
- retain legacy nullable wrappers, but throw on operational unavailability so
  `null` regains the meaning “confirmed absent.”

Verification:

- focused diff-impact and incomplete-migration tests;
- package public API fixture;
- compatibility documentation.

### Slice 5 — DBC-05: invocation coverage algebra

Red test first:

- complete plus omissions, continuation, unknown total, or unequal counts is
  rejected;
- incomplete known coverage has internally consistent counts;
- unknown coverage cannot claim omitted identities as complete knowledge;
- valid current producer variants still pass.

Implementation:

- replace the open interface with a union for known-complete,
  known-incomplete, and unknown coverage;
- strengthen `validateInvocationCoverage` with cross-field invariants;
- update every producer to construct one legal variant;
- keep all valid JSON field names unchanged.

Verification:

- CLI contract and output pagination tests;
- compile-time invalid-state fixture;
- registry-wide descriptor/coverage gate.

### Slice 6 — DBC-07: protocol discriminated unions

Red test first:

- incomplete output page without continuation fails to typecheck and decode;
- successful Worker response without result fails;
- failed Worker response without error fails;
- stopped/continued watcher, lock observation, and semantic availability
  require their state-specific fields.

Implementation:

- convert output page, Worker response, watch-loop result, watch stop result,
  process-lock observation, and semantic availability to tagged unions;
- update parsers to validate tag-specific fields;
- update producers and consumers by narrowing on the existing tag;
- preserve valid wire JSON.

Verification:

- protocol-specific unit tests;
- public compile fixture;
- full TypeScript build and CLI contract suite.

Implementation record — complete:

- the public protocol types are discriminated unions, and the untrusted JSON
  boundaries now decode the matching state-specific fields;
- the compile fixture rejects contradictory page, worker, watcher, lock, and
  semantic-availability states;
- 10 focused test files passed with 127 tests, alongside TypeScript, ESLint,
  and the public API compatibility check;
- the diff gate's `lsp-batch-worker.ts`/`lsp-session-worker.ts` co-change
  finding is accepted: the unchanged session worker imports and produces the
  newly strict response union, is compiled through the same package build,
  and its production path is covered by `rust-lsp-session.test.ts`;
- the two advisory architecture citations were reread. Their semantic-cache
  ownership and retained-generation claims remain true because this slice
  changed protocol state validation rather than cache keys or generation
  retention.

### Slice 7 — DBC-06: SQLite lifecycle ownership

Red test first:

- initialization failure after open closes the connection and releases the
  generation reader;
- validation failure does the same;
- normal and repeated close release exactly once;
- a package consumer cannot call `close()` or `pragma()` through `db`.

Implementation:

- place every post-open pragma and validation step inside one rollback scope;
- use `try/finally` so close failure cannot skip lease release;
- narrow public `db` to a read-only query/preparation port, keeping the raw
  connection private to lifecycle code;
- move internal direct operations through that port or wrapper methods.

Verification:

- real SQLite lifecycle tests plus the narrow outer-boundary seam if needed;
- public API fixture and snapshot;
- full query suite because the wrapper is foundational.

Implementation record — complete:

- one idempotent ownership object now couples the raw connection to its
  generation-reader release and makes every pragma, validation step, and
  remaining constructor operation part of the rollback scope;
- cleanup invokes both close and release even when either fails, preserves
  both failures when necessary, and becomes terminal before cleanup begins;
- the raw driver is private. The public `db` property is a frozen read-query
  port whose prepared statements do not expose `close`, `pragma`, `run`, or
  the driver's `database` back-reference;
- the intentional public narrowing is recorded as a breaking API change in
  `docs/api/changes/9f6e0d84b26f2b9f.json`, while valid prepared reads remain
  covered by the package-consumer fixture;
- 4 focused test files passed with 37 tests, including every pragma failure,
  path validation failure, dual cleanup failure, repeated close, immutable
  generation retention, and a persistent TypeScript semantic consumer;
- bounded migration, duplicate, wrapper, passthrough, re-export, abstraction,
  co-change, and doc-drift postchecks found no finding caused by this slice.
  Their pre-existing repository-wide candidates do not name the new ownership
  or query-port boundary. The API-evolution documentation citation remains
  accurate after its manifest update;
- refutation R1 tried to recover lifecycle methods from both the public port
  and a returned prepared statement, then tried prepared PRAGMA and DDL
  statements; the runtime and compile fixtures reject every route. Refutation
  R2 forced connection close and lease release to fail together; both errors
  were retained and a second close performed no work.

### Slice 8 — DBC-08: structured methods resolution

Red test first:

- exact class returns `matched`;
- no class returns `missing`;
- multiple candidates return `ambiguous` with candidates;
- `methods --json` prints valid JSON and a nonzero status for non-matches;
- the legacy wrapper retains its documented throw behavior.

Implementation:

- add `resolveMethods(db, { className })` returning a resolution union;
- make `methods` a deprecated compatibility wrapper;
- make the CLI consume the union directly;
- keep operational database/source failures as exceptions.

Verification:

- navigation query tests;
- CLI human and JSON tests;
- public API fixture and command reference.

Implementation record — complete:

- `resolveMethods(db, { className })` now returns a discriminated `matched`,
  `missing`, or `ambiguous` result. Exact matches include the resolved owner,
  missing matches include bounded name suggestions, and ambiguous matches
  include stable symbol-and-location candidates plus the known total;
- the deprecated `methods(db, className)` wrapper preserves its prior arrays
  and exception messages, while the CLI consumes the structured API directly;
- JSON-mode missing and ambiguous results remain valid result envelopes,
  include exact resolution coverage, and exit nonzero. Human mode gives the
  same concise qualification guidance without exposing a stack trace;
- the additive public API change is recorded in
  `docs/api/changes/2c9690623033ecdc.json` and exercised through the external
  package-consumer fixture;
- 6 focused test files passed with 70 tests across query resolution, CLI
  envelopes, human output, Clojure and definition fallbacks, generated
  command references, and descriptor contracts. TypeScript, ESLint, and the
  public API check also passed;
- complete SCIP references show the production consumers are the legacy
  wrapper, query barrel, and CLI handler. Full migration, duplicate,
  stale-abstraction, unused-parameter, and documentation-drift postchecks
  found no actionable candidate, and the full diff gate passed with no
  blocking or advisory findings;
- refutation R1 exercised the built CLI as a subprocess against a real
  ambiguous fixture database and proved stdout remained parseable JSON with
  status 1. Refutation R2 proved the legacy wrapper still throws for missing
  and ambiguous inputs and still returns an empty array for an exactly
  resolved class with no methods.

### Slice 9 — DBC-09: named primary public APIs

Red test first:

- named twin comparison, base-content, glob, and symbol-preexistence calls
  compile and behave correctly;
- positional wrappers remain callable;
- invalid absolute/project-relative path obligations are rejected at the
  boundary where applicable.

Implementation:

- add named option entry points for `twinAb`, base-content lookup,
  `pathMatchesGlob`, and `symbolPreexistenceChecker`;
- migrate internal callers to named APIs;
- deprecate positional wrappers without removing them.

Verification:

- focused query tests;
- public API fixture and snapshot;
- command documentation where a user-visible example changes.

## Dependency and ship order

The execution order is:

1. mailbox ownership;
2. cleanup inspection;
3. evidence-tier degradation;
4. base-content result;
5. coverage algebra;
6. protocol unions;
7. database ownership;
8. methods resolution;
9. named APIs;
10. generated artifacts and full verification.

Slices 1 and 2 are independent. Slices 3 and 4 touch the same diff-impact and
diff-gate area and therefore land serially. Slice 5 precedes Slice 6 because
coverage is one of the protocol unions. Slice 7 follows the protocol work so a
foundational storage change is validated against the stabilized types. Slice
8 is additive and could be implemented independently, but lands after the
foundational contracts to reduce concurrent API-snapshot churn. Slice 9 uses
the strict base-content API created in Slice 4.

Each slice receives its own commit after focused tests and `tsc` pass. The
final documentation/generated-artifact commit closes the audit and records
full-suite and diff-gate results. No release or npm publish is part of this
plan unless the user asks after verification.

## Adversarial attack record

### Attack A — Callback failure is merely an observability concern

Refuted. The audited runtime probe showed admission reopened after a completion
callback threw, while source ordering showed the durable inflight record
retained a live owner. Visibility does not preserve ownership.

### Attack B — Git-status failure will always make worktree setup fail too

Refuted. The commands have separate inputs, timeouts, output limits, and
failure modes. Even if many repository failures affect both, the verifier
cannot use one failed observation as proof that the other will fail.

### Attack C — Empty consumer maps are conservative

Refuted for a complete gate claim. An empty map is conservative only if the
result states that the evidence tier failed; otherwise it is
indistinguishable from the proof “there are no consumers.”

### Attack D — `null` is sufficient because callers only need content or none

Refuted. Incomplete-migration and diff-gate make different safety decisions
for “path absent at base” and “base could not be read.” Conflating them changes
the meaning of a negative result.

### Attack E — Runtime validation alone is enough for coverage

Refuted. Repository producers are TypeScript code. A union prevents new
contradictory producers before runtime, while validation remains necessary for
dynamic or deserialized values.

### Attack F — Making the raw database field private is needlessly disruptive

Partly accepted. Removing the field abruptly would be disproportionate.
Narrowing it to a query-only port preserves legitimate query use while making
lifecycle operations unavailable through the supported type.

### Attack G — Throwing for missing methods is idiomatic

Refuted at this boundary. Missing and ambiguous are expected query outcomes
already identified by the symbol resolver. They must be data so JSON mode can
remain JSON.

### Attack H — Named wrappers add surface without preventing misuse

Partly accepted. The positional wrappers remain temporarily for compatibility,
so misuse remains possible for callers that choose them. The plan makes named
APIs primary, migrates all internal use, adds deprecation, and reserves removal
for a later compatibility window.

## Derived verdict

P1 and P2 establish that DBC-01 requires both lane ordering and watcher
fail-stop behavior; changing only one leaves an invalid live-owner state.

P3 establishes that DBC-02 can be fixed centrally without a second cleanup
verification system.

P4 and P5 establish that DBC-03 and DBC-04 must propagate through partial
merging and both evidence-gate consumers; a local helper fix would be
incomplete.

P6 and P7 establish that type-level unions and runtime decoders must land
together while preserving valid JSON.

P8 establishes that database lifecycle enforcement must be validated broadly,
but a restricted query port avoids needless internal duplication.

P9 and P10 establish that the public API changes can be additive, with
compatibility wrappers retaining valid callers while machine-readable and
named APIs become primary.

Therefore the plan is implementable as nine bounded slices. It closes every
audited contract without introducing a parallel subsystem, and it identifies
the two intentional compatibility tightenings: contradictory protocol values
are rejected, and unsupported raw database lifecycle methods disappear from
the public TypeScript view.

## Final verification

After all slices:

1. run focused tests for every edited boundary;
2. run the complete test suite without parallel timeout inflation if needed;
3. run `tsc` and public API compatibility checks;
4. regenerate only owned docs/declarations, never concurrent `skills/**`;
5. run relevant SCIP postchecks and retrieve every emitted page;
6. run `scip-query diff-gate`;
7. fix every blocking result or record a narrow, evidence-backed acceptance;
8. update the audit with a finding-by-finding closure table and exact commands;
9. inspect `HEY.md` before staging;
10. stage explicit pathspecs and confirm no skill change enters a commit.
