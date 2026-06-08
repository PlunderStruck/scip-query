# Architecture Deepening Opportunities

Date: 2026-06-07
Scope: current checkout of `scip-query`
Lens: `/improve-codebase-architecture` — surface **shallow** modules that should
become **deep**, optimizing for testability and AI-navigability (not duplication
or dead code, which the health detectors already cover).

## Vocabulary

- **Module** — anything with an interface and an implementation.
- **Interface** — everything a caller must know: types, invariants, ordering,
  error modes, config. Not just the type signature.
- **Deep / Shallow** — deep = a lot of behavior behind a small interface;
  shallow = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behavior can be altered without
  editing in place. One adapter = hypothetical seam; two adapters = real seam.
- **Deletion test** — imagine deleting the module. If complexity *vanishes*, it
  was a pass-through (shallow). If complexity *reappears across N callers*, it
  was earning its keep (deep).
- **Locality** — maintainers fix change/bugs/knowledge in one place.
- **Leverage** — callers get more capability per unit of interface they learn.

## Method

Two read-only `Explore` passes (evidence/query layer; indexing/runtime
pipeline), then direct verification of the two most falsifiable claims against
the current `dist/`. No `CONTEXT.md` or `docs/adr/` exist, so the codebase's own
directory vocabulary (queries, symbols, semantic, reindex, language-parsers,
runtime, storage, resolution) is used as the domain language.

---

## Candidates (implemented)

### 1. Detector evidence and consumer classification — *implemented*

**Files:** `src/queries/dead.ts`, `src/queries/stale-abstractions.ts`,
`src/queries/wrapper-candidates.ts`, `src/queries/passthrough-candidates.ts`;
`src/queries/internal/{reference-counts,consumer-evidence}.ts`;
`src/symbols/call-graph-evidence.ts`.

**Problem:** "What counts as a *reference fact*" and "what counts as a *real
consumer*" were blurred together and answered differently in each detector:

- `dead.ts` gathers SCIP mentions, source fallback hits, and caller-map facts
  locally.
- `stale-abstractions.ts` filters barrel re-exports and import-only phantoms via
  stale-specific helpers.
- `wrapper-candidates.ts` filters entry/barrel/test files as callers but does
  not exclude import-only consumers.
- `reference-counts.ts` already records evidence provenance
  (`scip-mention | source-fallback | caller-map`), but the rule for *which
  source wins when* lives in the callers, not in a named evidence module.

This is the same concept the principal-maintainability register flagged as P0 #2
("detector evidence policy is too local"), only half-started: `consumer-evidence.ts`
and `reference-counts.ts` named the first slice; the merge/classification policy
is still scattered.

**Deletion test:** Concentrates. Delete the shared evidence/classification
module and each detector re-implements "load cross-file consumers → add source
fallback → filter re-export-only / import-only consumers." Complexity reappears
across multiple detectors.

**Implemented shape:** `src/queries/internal/consumer-evidence.ts` now owns both
the shared consumer-evidence map and the reusable consumer partition
(`realConsumers`, `barrelConsumers`, `importOnlyConsumers`). Detectors keep their
application rules: stale abstractions still decides how to score barrel and
import-only counts; wrapper candidates additionally filters entry/barrel/test
files before asking for real consumers.

**Benefits:**
- **Locality** — a bug in "what's a real reference" is fixed once, not in four
  detectors; wrapper import-only false callers use the same classification as
  stale abstractions.
- **Test surface** — the evidence contract becomes the thing under test;
  `tests/consumer-evidence.test.ts` pins re-export-only, import-only, and real
  consumers.

---

### 2. Single source of truth for language extensions — *implemented*

**Files:** `src/resolution/import-path-resolver.ts:27-35` ↔
`src/language-parsers/registry.ts:24-92`.

**Problem:** The per-language extension sets are duplicated verbatim across both
modules, kept in sync only by a comment (`import-path-resolver.ts:23-26`:
*"Kept in sync with the per-language parser extensions list… Duplicated here…"*).
A new extension (`.mts`, a new language) must be edited in both places or
detection silently drifts.

**Verification:** Confirmed — identical arrays in both files. Layer direction is
safe: `language-parsers` already imports `resolution` (e.g.
`jvm.ts`, `dart.ts`, `rust.ts`, `index.ts` all import from
`import-path-resolver.js`), and the drift policy allows `language-parsers →
resolution`. So `registry.ts` can import the constants directly with **no new
layer edge**.

**Deletion test:** The *duplicate copy* adds zero behavior — pure shallow
duplication. The resolver's logic is deep; the second extension list is not.

**Implemented shape:** `registry.ts` imports the existing `*_EXTENSIONS`
constants from the resolver. The resolver comment now names those constants as
the source of truth for both resolution and parser dispatch.

**Benefits:**
- **Locality** — one edit per language/extension change; removes a standing
  "keep these in sync by hand" hazard.
- ~10 lines, near-zero risk.

---

### 3. Vue augmentation transaction context — *implemented narrowly*

**Files:** `src/reindex/augment-vue.ts`, `src/reindex/augment-vue-runtime.ts`
(784 LOC), `src/reindex/augment-vue-contracts.ts`.

**Problem:** The public `augmentVueResolvedReferences` entry point is already
small, but the private transaction took DB, options, config path, and Vue files
as positional implementation details. That made the transaction harder to read
and test without pretending there is more than one adapter.

**Deletion test:** Concentrates — the transaction is real. **But** it has one
consumer, so a full swappable-executor abstraction would be frameworking. The
honest win is interface-hiding for navigability/testability, not pluggability.

**Implemented shape:** `runVueAugmentationTransaction` now accepts a single
`VueAugmentationTransactionContext`. Volar init, reference computation, chunk
replacement, and status output still stay together as one transaction.

**Benefits:** the transaction interface is smaller without adding a hypothetical
seam. Existing Vue augmentation tests still cover the public behavior.

---

### 4. Name the dead-code candidate gate — *implemented*

**Files:** `src/queries/dead.ts:130-177`, `src/core/project-index.ts:46-83`.

**Problem:** Whether a symbol is a valid dead-code candidate ran through a
~10-step *ordered, interdependent* filter sequence inside `dead.ts`'s loop:
ignore → module-like → value-like → enclosing-scope → test-file →
file-classifier → Rust trait-impl → Rust test-module → members → min-LOC. The
ordering was load-bearing but only named by comments.

**Deletion test:** Essential — delete it and `dead` floods with trait-impl /
test-module noise.

**Implemented shape:** `src/queries/internal/dead-candidate-gate.ts` now owns
`deadCandidateDecision`, returning explicit rejection reasons while keeping the
gate dead-specific. It was not promoted into a shared detector kernel.

**Benefits:**
- **Test surface** — the gate's ordering becomes unit-testable in isolation.
- **Locality** — the Rust-specific rules stop being buried mid-loop.

---

## Dropped candidates (considered, rejected)

- **Reindex coordinator unifying CLI + watcher.** The watcher's
  debounce/cooldown/dirty-flag state machine (`src/runtime/watch.ts:115-176`) is
  its *own* event lifecycle, which the register deliberately preserved — not
  duplicated reindex logic. The reindex flow itself
  (`reindex → runFreshReindex → runLanguageIndexersForFreshReindex →
  publishFreshReindexArtifacts`) is a long but linear pipeline whose levels each
  pass the deletion test.
- **Project-readiness facade (`ProjectSetup`).** `getProjectReadiness` was
  deliberately placed at `src/runtime/` to compose indexer + semantic readiness;
  bundling it into a broader facade is speculative frameworking.
- **Language-parser registry.** Already a deep seam: per-language grammar is
  essential variation behind a declarative table plus a deep caching/dispatch
  layer in `language-parsers/index.ts`. No change.
- **`DefinitionRangeMergePolicy`.** Already partly named in
  `src/symbols/symbol-row-policy.ts`.
- **`EvidenceCacheRegistry`.** Existing work in
  `src/queries/internal/cache-invalidation.ts` and the
  `2026-06-07-cache-invalidation-registry-atlas.md`; revisit only if a concrete
  cache-clear bug appears.

## Assessment

- **#1** was the real architectural win, with the key correction that evidence
  gathering and consumer classification are related but distinct.
- **#2** was completed as a direct consolidation.
- **#3 / #4** were completed narrowly, respecting the single-consumer Vue
  constraint and the no-shared-kernel detector constraint.

## Verification

- `npm test -- --run tests/consumer-evidence.test.ts tests/dead-candidate-gate.test.ts tests/stale-abstractions-accuracy.test.ts tests/file-wide-caller-fallback.test.ts tests/augment-sources.test.ts`
- `npm run typecheck`
