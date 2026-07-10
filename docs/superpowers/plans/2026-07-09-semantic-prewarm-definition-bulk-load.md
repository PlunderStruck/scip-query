# Semantic Prewarm Definition Bulk Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan inline. Do not use
> sub-agents for this campaign.

**Goal:** Reduce VegaAssistant warm full-health semantic prewarm from 24.704
seconds to at most 10 seconds and full command time from 41.933 seconds to at
most 30 seconds while preserving exact semantic and command payloads.

**Architecture:** First split the outer prewarm profile into four cardinality-
carrying child spans. If candidate loading owns the missing time, route only the
health-prewarm candidate scan through the existing set-oriented definition-row
pipeline; leave the per-file catalog and every other consumer unchanged. Reject
and revert the bulk route if it misses the performance or parity gates.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, SCIP SQLite indexes,
scip-query profile JSONL, existing performance architecture harness.

## Global Constraints

- Work directly on `main`; do not use sub-agents.
- Preserve byte-identical command output, ordered semantic reference/callee
  payloads, zero incomplete Rust references, and no worker fallback.
- Keep durable Rust semantic routing opt-in.
- Add no schema, cache-format, dependency, worker-thread, or native-binary
  change in this slice.
- Keep the outer prewarm marker fail closed.
- Retain instrumentation even if the bulk route is rejected.
- Run every production change through a witnessed RED/GREEN cycle.

---

## Current State

`runIsolatedHealthReport()` runs semantic prewarm serially before adaptively
parallel health phase processes. `runHealthSemanticPrewarm()` reads the marker,
loads definitions, materializes references, materializes callees, and writes a
complete marker. The default candidate loader calls
`ProjectIndex.scopedDefinitions()`, which delegates to
`getScopedDefinitions()`: indexed paths are enumerated and
`getDefinitionsForFile()` is called once per file.

Sources:

- `scip-query code runIsolatedHealthReport`
- `scip-query code runHealthSemanticPrewarm`
- `scip-query code 'src/runtime/cli-support.ts:239-254'`
- `scip-query code scopedDefinitions`
- `scip-query code 'src/symbols/definition-catalog.ts:317-359'`
- `scip-query code getDefinitionsForFile`

The accepted Vega warm profile records 24.704s in the outer prewarm span, while
named reference/callee/provider/write spans account for materially less. The
candidate loader has no child span. Cache writes are already batched in one
transaction and took only 98ms for references and 111ms for callees.

## Reuse Audit

- Reuse `profileSpan()` from `src/instrumentation/profile.ts`; do not add an
  instrumentation layer. Source: `scip-query code profileSpan`.
- Reuse `HealthSemanticPrewarmRuntime` as the injected side-effect contract and
  `fakePrewarmRuntime()` in `tests/runtime/cli-support.test.ts`.
- Reuse `getScopedDefinitionsMatchingSymbols()` for the set-oriented primary/
  fallback queries, grouping, merge policy, and source-range correction. Source:
  `scip-query code 'src/symbols/definition-catalog.ts:317-359'`.
- Add only one narrowly named prewarm candidate function in
  `src/runtime/cli-support.ts`; a new catalog module, worker, or generic option
  object is not justified.
- Keep `getDefinitionsForFile()` and its file-evidence cache untouched because
  it has 13 external consumers. Source:
  `scip-query change-surface src/symbols/definition-catalog.ts --json --full`.

## Testability Design

| Behavior              | Test seam                              | Dependencies                             | Pure core                                             | Side-effect shell                    | Contract                                                       |
| --------------------- | -------------------------------------- | ---------------------------------------- | ----------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Nested prewarm spans  | `prewarmHealthSemanticEvidence()`      | injected runtime, profile env/file       | span names and metadata selection                     | `profileSpan()` JSONL write          | four ordered successful child events with result cardinalities |
| Bulk candidate parity | `healthSemanticCandidateDefinitions()` | fixture `ScipDatabase`                   | semantic path filtering over set-oriented definitions | two SQLite queries plus source reads | deep-equal ordered candidates versus current scalar path       |
| Fail-closed prewarm   | existing prewarm unit cases            | injected runtime                         | marker/result state transitions                       | marker cache and semantic provider   | incomplete/unavailable work never writes marker                |
| Corpus parity         | performance harness                    | real external corpora and durable helper | output/digest comparison                              | CLI, rust-analyzer, SQLite evidence  | accepted hashes/counts/dispositions remain exact               |

---

### Task 1: Add hierarchical prewarm profiling

**Files:**

- Modify: `tests/runtime/cli-support.test.ts:135-281`
- Modify: `src/runtime/cli-support.ts:282-339`

**Interfaces:**

- Consumes: `HealthSemanticPrewarmRuntime` and `profileSpan()`.
- Produces: profile spans
  `health.semantic-prewarm.candidate-definitions`,
  `health.semantic-prewarm.references`,
  `health.semantic-prewarm.callees`, and
  `health.semantic-prewarm.marker-write`.

- [ ] **Step 1: Write the failing profile-event test.**

  **Source:** `scip-query code runHealthSemanticPrewarm` and the profile-env
  fixture pattern found with
  `rg -n 'SCIP_QUERY_PROFILE_OUT' tests/symbols/file-dep-graph.test.ts`.

  Add `mkdtempSync`, `readFileSync`, `rmSync`, `tmpdir`, and `join` imports.
  In the existing prewarm describe block, set `SCIP_QUERY_PROFILE=1` and a temp
  output path, run the complete fake runtime, restore both environment values in
  `finally`, parse JSONL, and assert the child events are exactly:

  ```ts
  expect(
    events
      .filter((event) => event.name.startsWith('health.semantic-prewarm.'))
      .map(({ name, definitions, rows }) => ({ name, definitions, rows })),
  ).toEqual([
    { name: 'health.semantic-prewarm.candidate-definitions', definitions: 2 },
    { name: 'health.semantic-prewarm.references', definitions: 2, rows: 2 },
    { name: 'health.semantic-prewarm.callees', definitions: 2, rows: 1 },
    { name: 'health.semantic-prewarm.marker-write' },
    { name: 'health.semantic-prewarm', definitions: 2 },
  ]);
  ```

- [ ] **Step 2: Run the focused test and witness RED.**

  Run:

  ```bash
  npx vitest run tests/runtime/cli-support.test.ts
  ```

  Expected: the new assertion sees only the existing outer span; the four child
  names are absent.

- [ ] **Step 3: Implement the minimal child spans.**

  **Source:** `scip-query code profileSpan`.

  Wrap only the four existing runtime calls. Capture the returned values in
  variables so metadata closures report post-call cardinalities:

  ```ts
  let definitions: IndexedDefinition[] = [];
  definitions = profileSpan(
    'health.semantic-prewarm.candidate-definitions',
    () => runtime.candidateDefinitions(db, opts),
    () => ({ definitions: definitions.length }),
  );
  ```

  Apply the same shape to reference and callee materialization with
  `{ definitions: definitions.length, rows: ... }`. Wrap the existing marker
  write with the marker-write span. Do not change ordering or result logic.

- [ ] **Step 4: Run the focused test and witness GREEN.**

  Run the Step 2 command. Expected: all cli-support tests pass.

- [ ] **Step 5: Run nearby tests, typecheck, and build.**

  ```bash
  npx vitest run tests/runtime/cli-support.test.ts tests/runtime/health-report-cache.test.ts
  npm run typecheck
  npm run build
  ```

  Expected: every command exits 0.

- [ ] **Step 6: Commit the instrumentation.**

  ```bash
  git add src/runtime/cli-support.ts tests/runtime/cli-support.test.ts
  git commit -m "perf: profile semantic prewarm stages"
  ```

---

### Task 2: Measure the unmodified candidate path

**Files:**

- Append: `docs/benchmarks/runs/2026-07-09-semantic-prewarm-bulk-load.jsonl`
- Create: descriptive local and Vega profile artifacts under
  `docs/benchmarks/runs/`.

**Interfaces:**

- Consumes: the built instrumented CLI and existing evidence-cold harness.
- Produces: exact child-span attribution before any routing change.

- [ ] **Step 1: Run local evidence-cold/session-warm controls.**

  Use `scripts/performance-architecture-contract.mjs` with
  `SCIP_RUST_SEMANTIC_DURABLE_SESSION=1`, command
  `health --full --json`, cache state `evidence-cold`, the new JSONL history,
  and distinct cold/warm profile paths.

- [ ] **Step 2: Run Vega evidence-cold/session-warm controls.**

  Run the same harness against `/Users/aydansalois/Documents/GitHub/VegaAssistant`.
  A new build must first report `created`; the second command must report
  `reused` and a response-cache hit.

- [ ] **Step 3: Record the attribution decision.**

  Sum the four child spans and compare them with the outer 24.704s accepted
  baseline. Continue to Task 3 only if candidate loading is the largest missing
  span and at least 5 seconds on Vega. Otherwise stop the bulk route and select
  the actual largest child span from the new profile.

- [ ] **Step 4: Commit the diagnostic history.**

  ```bash
  git add docs/benchmarks/runs/2026-07-09-semantic-prewarm-bulk-load.jsonl
  git commit -m "bench: attribute semantic prewarm stages"
  ```

  Large raw profiles remain local unless already tracked by repository policy;
  the JSONL record must contain their absolute paths, timings, hashes, counts,
  and dispositions.

---

### Task 3: Route health candidates through the set-oriented catalog

**Files:**

- Modify: `tests/runtime/cli-support.test.ts`
- Modify: `src/runtime/cli-support.ts:239-253`

**Interfaces:**

- Consumes: `getScopedDefinitionsMatchingSymbols()`, `ScipDatabase`, optional
  scope, and `semanticProviderLanguageForPath()`.
- Produces:
  `healthSemanticCandidateDefinitions(db: ScipDatabase, scope?: string): IndexedDefinition[]`.

- [ ] **Step 1: Write a failing public-seam test.**

  **Source:** `scip-query refs getScopedDefinitionsMatchingSymbols` and
  `tests/fixtures/evidence-fixture.ts` (test-only raw fixture because test files
  are absent from the SCIP symbol index).

  Import the wished-for `healthSemanticCandidateDefinitions`. Build a mixed
  fixture with TypeScript, Rust, and unsupported-language documents plus a
  nested scope. Assert its full and scoped results deeply equal:

  ```ts
  new ProjectIndex(db)
    .scopedDefinitions(scope)
    .filter((definition) => semanticProviderLanguageForPath(definition.relativePath) !== null);
  ```

  Compare complete objects and order, not just counts.

- [ ] **Step 2: Run the focused test and witness RED.**

  ```bash
  npx vitest run tests/runtime/cli-support.test.ts
  ```

  Expected: import/export failure because
  `healthSemanticCandidateDefinitions` does not exist.

- [ ] **Step 3: Implement the minimal bulk candidate function.**

  **Source:**
  `scip-query code 'src/symbols/definition-catalog.ts:317-359'`.

  Add the existing catalog import and implement:

  ```ts
  export function healthSemanticCandidateDefinitions(db: ScipDatabase, scope?: string): IndexedDefinition[] {
    return getScopedDefinitionsMatchingSymbols(db, {
      scope,
      symbolMatches: () => true,
    }).filter((definition) => semanticProviderLanguageForPath(definition.relativePath) !== null);
  }
  ```

  Replace only `DEFAULT_HEALTH_SEMANTIC_PREWARM_RUNTIME.candidateDefinitions`
  with `(db, opts) => healthSemanticCandidateDefinitions(db, opts.scope)`.
  Leave `ProjectIndex.scopedDefinitions()` and every other caller untouched.

- [ ] **Step 4: Run the focused test and witness GREEN.**

  Run the Step 2 command. Expected: all cli-support tests pass with exact deep
  equality for full and scoped fixtures.

- [ ] **Step 5: Run definition and semantic neighbors.**

  ```bash
  npx vitest run \
    tests/runtime/cli-support.test.ts \
    tests/symbols/definition-catalog.test.ts \
    tests/semantic/rust/rust-semantic-cache-gate.test.ts \
    tests/semantic/rust/rust-semantic-callee-cache-gate.test.ts
  npm run typecheck
  npm run build
  ```

  Expected: all commands exit 0.

- [ ] **Step 6: Run new-helper postchecks.**

  ```bash
  scip-query recent-duplicates
  scip-query unused-params
  ```

  Expected: no unresolved finding.

- [ ] **Step 7: Commit the reversible routing slice.**

  ```bash
  git add src/runtime/cli-support.ts tests/runtime/cli-support.test.ts
  git commit -m "perf: bulk load health semantic candidates"
  ```

---

### Task 4: Benchmark and accept or revert

**Files:**

- Append: `docs/benchmarks/runs/2026-07-09-semantic-prewarm-bulk-load.jsonl`
- Update:
  `docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md`
- Update: approved design and this plan's checkboxes.

**Interfaces:**

- Consumes: built bulk-route CLI and accepted response-cache corpus contracts.
- Produces: an explicit accepted or rejected disposition.

- [ ] **Step 1: Run local and Synth cold/warm controls.**

  Require internal exactness locally and readiness-v2 exact external hashes on
  SynthRunnerRust. Reject immediately on fact drift, incomplete Rust references,
  or unexpected worker fallback.

- [ ] **Step 2: Run Vega cold/warm controls.**

  Compare stdout SHA-256, ordered reference/callee digests, row/fact/nonempty
  counts, incomplete count, durable dispositions, response-cache hit, outer
  prewarm, and all four child spans.

- [ ] **Step 3: Apply the decision gate.**

  Accept only when Vega warm prewarm is at most 10 seconds, end-to-end full
  health is at most 30 seconds, external payloads are exact, and local/Synth do
  not materially regress. If rejected, revert Task 3's production/test commit
  with `git revert` and retain Task 1 instrumentation plus all measurements.

- [ ] **Step 4: If accepted, run invalidation and reverse-order controls.**

  Use the established scoped helper-PID shutdown procedure. Require the five
  dispositions `created`, `reused`, `invalidated`, `reused`, `created`; response
  hits only on reused controls; and exact payloads throughout.

- [ ] **Step 5: Update the ledger and run history.**

  Document the measured attribution, accepted/rejected route, exact corpus
  identities, and the new largest child span. Do not state that Rust is needed
  unless the accepted profile isolates a large contiguous CPU-bound remainder.

---

### Task 5: Full verification and closeout

**Files:**

- Verify all accepted source, tests, docs, plan, JSONL, and profile references.

**Interfaces:**

- Consumes: final accepted or reverted tree.
- Produces: a verified clean campaign checkpoint.

- [ ] **Step 1: Run full repository checks.**

  ```bash
  npm test
  npm run lint
  npm run typecheck
  npm run build
  ```

- [ ] **Step 2: Run routed SCIP checks.**

  ```bash
  scip-query recent-duplicates
  scip-query unused-params
  scip-query reindex
  scip-query diff-gate
  ```

- [ ] **Step 3: Validate artifacts and scope.**

  ```bash
  jq -e . docs/benchmarks/runs/2026-07-09-semantic-prewarm-bulk-load.jsonl >/dev/null
  git diff --check
  git status --short
  ```

- [ ] **Step 4: Commit closeout documentation.**

  Stage only campaign-owned files and commit the final disposition. Do not push
  unless the user separately requests it.

## Stress-Test Findings

- The definition catalog is high-risk globally, so the first production route
  changes only the prewarm caller and reuses an existing bulk function.
- The set-oriented path bypasses the per-file definition evidence read. Exact
  fixture and corpus parity are therefore mandatory; the file cache remains
  authoritative for every existing scalar consumer.
- SQLite writes are not the current target: measured semantic batch writes are
  about 0.21s total.
- More rust-analyzer processes are explicitly excluded because the measured
  parallel experiment was slower.
- If source-range correction dominates after bulk routing, it is partitionable
  by file and becomes a possible persistent-Rust/Rayon boundary; that decision
  requires a new design and approval.

## Ship Order

1. Instrumentation commit — deployable and retained independently.
2. Diagnostic baseline commit — no product behavior change.
3. Bulk prewarm route commit — reversible two-way door.
4. Acceptance/revert decision and five-control evidence.
5. Full verification and closeout commit.
