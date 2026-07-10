# Bulk Rust SCIP Reference Materialization Implementation Plan

> **For agentic workers:** Execute this plan inline in the current task. Do not
> use sub-agents. Track every checkbox and preserve unrelated dirty-worktree
> changes.

**Goal:** Remove the next measured Rust reference bottleneck by bulk-materializing
only proven standard-trait occurrence rows, then continue profiling until Vega
warm full health is at most 50 seconds with exact semantic parity.

**Architecture:** Extend the existing SCIP occurrence reference policy in
`src/semantic/rust/scip-occurrence-references.ts`; do not add a second index or
provider. Make scalar and bulk routing share one post-index decision, add a
policy revision to the Rust semantic cache identity, and delegate every
unsupported or ambiguous definition to rust-analyzer.

**Tech Stack:** TypeScript, Vitest, serialized SCIP via `@c4312/scip`, SQLite
evidence cache, rust-analyzer durable sessions, scip-query profiling.

## Global Constraints

- Work directly on `main` and do not use sub-agents.
- Preserve exact command/reference/callee payloads and zero incomplete Rust
  references.
- Fail closed to rust-analyzer when SCIP evidence is absent, malformed, or
  ambiguous.
- Keep durable routing opt-in and preserve readiness-v2 behavior.
- Preserve unrelated dirty-worktree changes and never kill unrelated processes.
- Do not accept the campaign until Vega warm `health --full` is at most 50s or
  the next evidence-backed bottleneck has also been pursued.

---

## Current Evidence

- Accepted Vega warm full health: 80.97–83.86s.
- `semantic.references.provider-loop`: 64.585s.
- `rust.semantic.worker.references`: 61.130s for 21,581 definitions.
- Existing safe SCIP path: 16,592 definitions and 45,329 references.
- Fallback parity audit: 91 standard-trait rows excluding `Default`; 90 exact.
- Safe rule proven by the audit: all SCIP-positive audited standard-trait rows;
  SCIP-zero audited standard traits except `From`; never `Default` or custom
  traits.
- Source profiles:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-retry-readiness-20260709T225912Z-session-warm.profile.jsonl`,
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-phase-timeout30-reference-task-profile.profile.jsonl`,
  `/tmp/vega-rust-reference-parity.jsonl`, and
  `/tmp/synth-rust-reference-parity.jsonl`.
- SCIP commands:
  `scip-query plan-context src/semantic/shared-primitives.ts`,
  `scip-query code semanticReferenceMap`,
  `scip-query code rustScipOccurrenceReferenceMap`, and
  `scip-query code rustSemanticEngineIdentity`.

## Reuse and Testability Audit

Reuse `rustScipOccurrenceReferenceMap()`, its process-local `WeakMap` index,
`dedupeSemanticReferences()`, `isRustTraitImplMember()`, and the existing
semantic cache fingerprint. A new module or cache product is not justified.
One small pure policy helper in the existing reference module is justified
because eligibility now depends on both symbol shape and occurrence count,
which are known on opposite sides of the current pre-index predicate.

The pure core decides whether a trait/occurrence-count pair is exact. The
side-effect shell reads and deserializes `index.scip`. Temp-project fixtures
inject the file system, SCIP bytes, and SQLite database. The observable
contract is `SemanticReference[] | null`: an array, including `[]`, is a proof;
`null` means rust-analyzer must answer.

### Task 1: Record and review the design

**Files:**

- Create: `docs/superpowers/specs/2026-07-09-bulk-rust-scip-reference-materialization-design.md`
- Create: `docs/plans/2026-07-09-bulk-rust-scip-reference-materialization.md`

**Interfaces:**

- Consumes: accepted ledger/profile/parity evidence.
- Produces: exact routing, cache-invalidation, test, and benchmark contracts.

- [x] **Step 1: Compare three routing strategies and select the fail-closed rule.**
- [x] **Step 2: Document data flow, exclusions, cache identity, and acceptance gates.**
- [x] **Step 3: Self-review both documents.**

Run:

```bash
rg -n 'TB[D]|TO[D]O|implement la[t]er|fill in detai[l]s' \
  docs/superpowers/specs/2026-07-09-bulk-rust-scip-reference-materialization-design.md \
  docs/plans/2026-07-09-bulk-rust-scip-reference-materialization.md
```

Expected: no output.

### Task 2: Prove the routing contract test-first

**Files:**

- Modify: `tests/semantic/rust/rust-scip-occurrence-references.test.ts`
- Modify: `tests/semantic/rust/rust-engine-identity.test.ts`
- Modify: `src/semantic/rust/scip-occurrence-references.ts`
- Modify: `src/semantic/rust/engine-identity.ts`

**Interfaces:**

- Consumes: `IndexedDefinition`, the cached SCIP occurrence index, and the
  current `safe | all` mode.
- Produces: one shared scalar/bulk routing decision and
  `scipOccurrenceReferencePolicyRevision: 2` in `RustSemanticEngineIdentity`.

- [x] **Step 1: Add fixture symbols and failing assertions.**

Add real serialized SCIP rows for positive `Display::fmt` and `From::from`, plus
definitions for empty `Debug::fmt`, empty `From::from`, `Default::default`, and
a custom trait. Assert positive standard rows return exact positions, empty
`Debug` returns `[]`, and every ambiguous row returns `null`/is absent from the
bulk map. Assert the engine identity exposes revision `2`.

- [x] **Step 2: Run the focused tests and verify RED.**

Run:

```bash
npx vitest run \
  tests/semantic/rust/rust-scip-occurrence-references.test.ts \
  tests/semantic/rust/rust-engine-identity.test.ts
```

Expected: assertions for standard-trait routing and policy revision fail while
all pre-existing assertions still execute.

- [x] **Step 3: Implement the minimal policy.**

Keep the fixed audited trait set in
`src/semantic/rust/scip-occurrence-references.ts`. Extract the trait descriptor
from the rust-analyzer SCIP symbol, accept positive `From`, accept zero/positive
other allowlisted traits, and reject `Default`, zero `From`, custom traits, and
parse failures. Use the same post-index decision from scalar and bulk paths.
Add `scipOccurrenceReferencePolicyRevision: 2` to the Rust semantic engine
identity so old rows cannot be reused under the new routing policy.

- [x] **Step 4: Run the focused tests and verify GREEN.**

Run the Step 2 command.

Expected: both files pass with no warnings.

- [x] **Step 5: Run nearby semantic tests.**

Run:

```bash
npx vitest run \
  tests/semantic/rust/rust-scip-occurrence-references.test.ts \
  tests/semantic/rust/rust-scip-occurrence-callees.test.ts \
  tests/semantic/rust/rust-engine-identity.test.ts \
  tests/semantic/rust/rust-semantic-cache-gate.test.ts \
  tests/semantic/rust/rust-semantic-provider.test.ts
```

Expected: all tests pass.

### Task 3: Verify the first slice cheaply

**Files:**

- Modify only if a focused test exposes a defect in Task 2.

**Interfaces:**

- Consumes: built CLI and the existing local/Synth harness.
- Produces: exact local and Synth payload/digest comparisons before Vega cost.

- [x] **Step 1: Run typecheck and build.**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [x] **Step 2: Run evidence-cold/session-warm local and Synth controls.**

Use the existing performance architecture harness and the exact accepted
readiness-v2 environment. Record wall time, output SHA-256, ordered semantic
payload digest, reference/callee row counts, incomplete count, session
disposition, and worker-fallback count in new profile artifacts.

Expected: byte-identical output and ordered payload digests, zero incomplete
Rust references, expected session reuse, and no worker fallback.

### Task 4: Measure Vega and choose the next bottleneck

**Files:**

- Append: `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl`
- Append: `docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md`
- Create: descriptive Vega profile/output/evidence artifacts under
  `docs/benchmarks/runs/`.

**Interfaces:**

- Consumes: a new-build evidence-cold/session-warm Vega pair.
- Produces: a correctness disposition and a new critical-path profile.

- [x] **Step 1: Run the Vega evidence-cold/session-warm pair.**
- [x] **Step 2: Compare byte output, ordered semantic payloads, row counts,
      incomplete rows, dispositions, and fallback counts to readiness-v2.**
- [x] **Step 3: If warm time is above 50s, retain the run as diagnostic and
      select the next implementation slice from the largest remaining wall
      span; repeat Tasks 2–4 test-first.**
- [x] **Step 4: Once warm time is at most 50s, run invalidation and reverse-order
      local, Synth, and Vega controls.**

Expected: the accepted result is at most 50s and all payload/order gates match.

### Task 4a: Run reference and callee gaps on two durable workers

**Files:**

- Modify: `src/semantic/rust/lsp-session.ts`
- Modify: `src/semantic/rust/durable-session-server.ts`
- Modify: `tests/semantic/rust/rust-lsp-session.test.ts`

**Interfaces:**

- Consumes: the existing combined `RustReferenceWorkerRequest` and two
  persistent worker-thread requesters.
- Produces: the same `RustReferenceWorkerResponse`, merged only after both
  reference-only and callee-only requests complete.

- [x] **Step 1: Write a failing concurrency/merge test.**

Inject two fake startable requesters. Assert both `startSemantic()` calls occur
before either `response()` call, reference and callee definition lists/flags are
split correctly, the merged response preserves references, callees, reason,
availability, and incomplete reference IDs, and shutdown reaches both workers.

- [x] **Step 2: Run the focused test and verify RED.**

```bash
npx vitest run tests/semantic/rust/rust-lsp-session.test.ts
```

Expected: the new parallel requester export/API is missing.

- [x] **Step 3: Implement the minimal start/response seam and opt-in wrapper.**

Refactor the existing worker requester so `requestSemantic()` delegates to a
startable pending request with one absolute timeout budget. Add a wrapper that
splits only combined reference+callee requests, starts both persistent workers,
awaits both, merges their response fields, and resets both workers after an
error. In the durable server, select the wrapper only when
`SCIP_RUST_SEMANTIC_PARALLEL_REQUESTS=1`; leave every default path unchanged.

- [x] **Step 4: Run focused tests, typecheck, and build.**

```bash
npx vitest run \
  tests/semantic/rust/rust-lsp-session.test.ts \
  tests/semantic/rust/rust-durable-session.test.ts
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [x] **Step 5: Run opt-in Synth and Vega cold/warm controls.**

Expected: Synth remains byte/digest exact. Vega must be byte/digest exact,
report zero incomplete rows and no fallback, and measure at most 50 seconds
warm. Otherwise revert the parallel wrapper and retain its artifacts as
diagnostic evidence.

Measured decision: rejected and reverted. Synth was exact, but Vega warm was
96.200s at concurrency 8, 109.572s at concurrency 16, and 95.185s at
concurrency 4.

### Task 4b: Reuse one complete combined response in the live helper

**Files:**

- Modify: `src/semantic/rust/durable-session.ts`
- Modify: `tests/semantic/rust/rust-durable-session.test.ts`

**Interfaces:**

- Consumes: `DurableRustSessionRequest`, the existing compiler-session identity,
  and a complete `RustReferenceWorkerResponse`.
- Produces: the same response/session envelope without a second worker call when
  the exact semantic request recurs under the same live identity.

- [x] **Step 1: Write failing reuse and fail-closed tests.**

Assert that an identical available, complete semantic request calls the worker
once across two host requests even when only `readinessDeadlineMs` changes.
Assert changed definitions/policy settings miss, identity invalidation clears,
and unavailable or incomplete responses are never retained. Import-definition
requests must remain uncached.

- [x] **Step 2: Run the focused test and verify RED.**

```bash
npx vitest run tests/semantic/rust/rust-durable-session.test.ts
```

Expected: the identical complete request is forwarded twice.

- [x] **Step 3: Implement the bounded in-memory response entry.**

Keep one complete semantic response in `DurableRustSessionHost`, keyed by a
stable hash of the request with `readinessDeadlineMs` omitted. Clear it before
identity replacement and on shutdown. Return a cache hit only under the reused
identity; store only `available: true` responses whose incomplete-reference ID
list is absent or empty.

- [x] **Step 4: Run focused tests, typecheck, and build.**

```bash
npx vitest run \
  tests/semantic/rust/rust-durable-session.test.ts \
  tests/semantic/rust/rust-lsp-session.test.ts
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [x] **Step 5: Run exact local, Synth, and Vega cold/warm controls.**

Expected: every cold command performs compiler work; every warm command reports
`reused`, hits the response entry, preserves exact ordered payload digests with
zero incomplete rows/no fallback, and Vega warm is at most 50 seconds.

### Task 5: Full verification and campaign closeout

**Files:**

- Update: benchmark ledger and JSONL history with accepted and rejected runs.
- Update: this plan’s checkboxes.

**Interfaces:**

- Consumes: accepted implementation and corpus evidence.
- Produces: repository-wide proof and a cleanly scoped handoff.

- [x] **Step 1: Run full checks.**

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Expected: every command exits 0.

- [x] **Step 2: Run routed SCIP verification.**

```bash
scip-query recent-duplicates
scip-query unused-params
scip-query reindex
scip-query diff-gate
```

Expected: no unresolved finding; any accepted finding is documented with
evidence.

- [x] **Step 3: Inspect only owned changes and document unrelated dirt.**

```bash
git diff -- \
  src/semantic/rust/durable-session.ts \
  tests/semantic/rust/rust-durable-session.test.ts \
  docs/superpowers/specs/2026-07-09-bulk-rust-scip-reference-materialization-design.md \
  docs/plans/2026-07-09-bulk-rust-scip-reference-materialization.md \
  docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md \
  docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl
```

Expected: only the accepted response reuse, its tests, and campaign evidence.
The standard-trait and parallel-worker source experiments were reverted. The
worktree still contains unrelated earlier campaign changes and artifacts, which
remain unstaged and untouched by this closeout.

## Ship Order

1. Design and plan.
2. Failing routing/cache-identity tests.
3. Minimal standard-trait bulk policy.
4. Focused and nearby verification.
5. Cheap corpora, then Vega cold/warm.
6. Profile-driven iteration until the target is met.
7. Five controls, full checks, SCIP gates, ledger/history closeout.
