# Incomplete-migration detector

**Date:** 2026-06-10
**Status:** implemented — all phases complete, 230/230 tests green, gate run
on the implementing diff itself produced zero incomplete-migration findings
and zero new baseline findings.

## Goal (Gate A)

Coding agents extract a helper or abstraction, rewire one or two call sites
into it, and miss the remaining sites that contain the same logic. The result
is a half-finished migration: the new abstraction exists, some sites use it,
and near-identical inline copies survive elsewhere.

The user wants this caught **at diff time**, the way `diff-gate` catches
echoes and missing co-change partners. "Done" means:

1. A standalone `scip-query incomplete-migration` command that, given a base
   ref, reports: *new helper H was wired into N site(s) in this diff, but M
   other site(s) contain its logic inline and were not migrated* — with the
   un-migrated sites named.
2. The same detector running as a `diff-gate` check so agents hit it before
   committing.

The co-change-partner half of the original idea **already exists**
(`runCoChangePartnerCheck`, `src/queries/diff-gate.ts:125-160` — Source:
`scip-query code 'src/queries/diff-gate.ts:1-228'`). No work needed there.

## Current state (Gate B)

All claims verified via scip-query on 2026-06-10 (`scip-query reindex` run first).

### Diff → symbol mapping

- `diffImpactPlan(db, {base})` (`src/queries/diff-impact.ts:60-79`, Source:
  `scip-query code 'src/queries/diff-impact.ts:42-115'`) returns
  `changedFileLines` (git-root-relative) and `changedFiles` (index-relative,
  filtered to indexed, non-ignored files). `getChangedFiles`
  (`src/queries/diff-impact.ts:176-199`) unions unstaged, staged, and
  untracked files. There is **no hunk-level or added-symbol detection
  anywhere** — `diffImpactPartial` treats every definition in a changed file
  as changed (Source: `scip-query code 'src/queries/diff-impact.ts:81-115'`).
- `scipFanIn` / `scipConsumerFiles` (`src/queries/diff-impact.ts:251-285`)
  show the established SQL shape for reference queries: `mentions m JOIN
  chunks c JOIN documents` with `m.role != 1` excluding definitions, plus
  `db.pathExclusionsFor(...)` (Source: `scip-query code
  'src/queries/diff-impact.ts:223-310'`).

### Similarity machinery

- `similar()` / `similarAll()` (`src/queries/similar.ts:44-213`, Source:
  `scip-query code 'src/queries/similar.ts:44-213'`) score **symmetric**
  IDF-weighted cosine over callee fingerprints. Fingerprints come from
  private `findCallees` (`similar.ts:249-267`) and `getAllCalleeFingerprints`
  (`similar.ts:272-298`), which use `ProjectIndex.productionCallableDefinitions`
  (test/ignored/suppressed filtering) and `ProjectIndex.calleeMap` with a
  `semantic` flag, then strip infrastructure callees via `meaningfulCallees`.
- Math primitives live in `src/analysis/similarity.ts` (`intersection`,
  `jaccard`, `computeIdf`, `getMedianIdf`, `weightedCosine`; Source:
  `scip-query code 'src/analysis/similarity.ts:1-120'`, `scip-query surface
  src/analysis/similarity.ts`). The module's documented job is owning the
  set/score primitives the similar* queries share.

**Why symmetric cosine is the wrong score for this detector:** an un-migrated
site contains the helper's logic *inline plus its own surrounding logic* — its
callee set is a superset of the helper's. Cosine divides by both magnitudes,
so the site's unique callees dilute the score and big sites slip under the
threshold. The correct score is **containment**: `|helper ∩ site| / |helper|`.
That primitive does not exist yet (verified: `scip-query surface
src/analysis/similarity.ts` lists only the five primitives above).

### diff-gate

- `diffGate` (`src/queries/diff-gate.ts:58-93`) runs six checks; each check
  is a `run<Name>Check(db, ..., result)` function pushing
  `{check, message, remediation}` findings. Check names are a string union
  `DiffGateCheck` (`diff-gate.ts:13-19`). Source: `scip-query code
  'src/queries/diff-gate.ts:1-228'`.
- The echo check (`diff-gate.ts:95-123`) caps per-diff work with
  `maxEchoChecks = 10` and skips pairs where both sides are in the diff —
  the precedent for this detector's caps and exclusions.

### Registration ripple for a new query command

Verified via `scip-query code` on each file plus `tests/cli-contract.test.ts`
(tests are **not in the SCIP index** — `scip-query files 'git-history.test'`
returns nothing — so test-file claims below come from direct inspection, the
documented fallback):

1. `src/queries/<name>.ts` — the query module.
2. `src/queries/index.ts` barrel export (`index.ts:25-45`).
3. A `CommandDescriptor` in `src/runtime/query-commands/impact.ts`
   (`impactQueryCommandDescriptors`, `impact.ts:90-141`) — heuristic commands
   **must contain "candidate" in the description** (cli-contract test
   "keeps heuristic classification descriptor-owned").
4. `queryCommandOrder` in `src/runtime/query-command-specs.ts:10-64`.
5. `PUBLIC_QUERY_ENTRIES` in `src/queries/public-query-entries.ts:13-66`
   (alphabetical) — drives tsup entries automatically (`tsup.config.ts:1-6`)
   but `package.json` `exports` must be edited by hand; the contract test
   checks bidirectional lockstep.
6. `docs/COMMAND_REFERENCE.md` generated block — `npm run docs:commands`
   prints the block to stdout; splice it between the BEGIN/END markers.
7. **Found during implementation:** `src/runtime/command-descriptors.ts`
   also lists every query command explicitly as `query('<id>')` — a seventh
   registration point the discovery pass missed (`command-descriptors.ts:79`).

### Test conventions

- Git-dependent: temp repo via `mkdtempSync` + `execFileSync('git', ...)` with
  pinned author/committer dates (`tests/git-history.test.ts`).
- Index-dependent: hand-built SQLite fixture via shared `createEvidenceSchema`
  (`tests/evidence-fixture.ts`) or per-suite schema
  (`tests/diff-impact-accuracy.test.ts`); callee-fingerprint behavior is
  exercised in `tests/command-accuracy.test.ts` with fixture source files +
  fixture DB (`tests/command-accuracy-fixtures.ts`).

### Non-obvious invariants to preserve

- `diffImpactPlan` returns `note` when git fails; queries must degrade to an
  `available: false`-style result, not throw (pattern: `recentDuplicates`
  returns `{available: false}` when `getFileAddRecords` is null,
  `recent-duplicates.ts:53-54`).
- `semantic` option convention is `opts.semantic !== false` (default on) —
  `similar.ts:51,57,148`.
- Heuristic output prints a disclaimer banner driven by
  `descriptor.heuristic.label` (cli-contract test asserts the rendering).
- The repo commits a health baseline; `runBaselineCheck` compares against it.
  New code must not introduce baseline findings (or the gate on our own diff
  fails — verification step 5.4).

## Reuse audit (Gate C)

Queries run: `scip-query similar diffGate`, `scip-query similar
recentDuplicates`, `scip-query surface src/queries/similar.ts`, `scip-query
surface src/analysis/similarity.ts`, `scip-query outline
src/queries/extract-candidates.ts`, full reads of `diff-gate.ts`,
`recent-duplicates.ts`, `similar.ts`, `diff-impact.ts`, `git-history.ts`.

| Proposed symbol | Verdict |
|---|---|
| `containment()` | **New, justified.** `analysis/similarity.ts` owns `jaccard`/`weightedCosine` but has no asymmetric containment; that module's documented job is exactly these primitives, so it gets the new one. |
| `incompleteMigration()` | **New, justified.** No existing query detects partial extractions. `recentDuplicates` is the nearest neighbor (new code echoing established code) but is symmetric-similarity over whole functions and has no diff/new-symbol/wired-in logic. `extractCandidates` is intra-function callee clustering — different problem. |
| New-symbol detection | **New, justified.** No hunk parsing or base-content comparison exists anywhere (`diff-impact` is file-granular). Implemented as leaf-name-absent-at-base via `git show <base>:./<path>` — reuses the `execFileSync` git pattern from `diff-impact.ts:176-199`. |
| Helper fingerprint / candidate corpus | **Reuse.** Export the existing private `findCallees` + `getAllCalleeFingerprints` + `SymbolFingerprint` from `similar.ts` instead of re-implementing (precedent: `analysis/similarity.ts` exists precisely to share these layers; `diff-gate` already imports `similar`). |
| Wired-in / reference check | **Reuse pattern.** Same SQL shape as `scipFanIn`/`scipConsumerFiles` (`diff-impact.ts:251-285`), but needs referencing *file paths without exclusion of changed files*, which neither exports — small local query, shape-matched. |
| IDF significance gate | **Reuse.** `computeIdf` + `getMedianIdf` from `analysis/similarity.ts`. |
| diff-gate check | **Reuse.** New `runIncompleteMigrationCheck` follows the existing `run*Check` shape exactly. |

## Design

### Detector semantics

For diff `base..worktree`:

1. **Changed files** via `diffImpactPlan` (reuse).
2. **New helpers**: production callable definitions in changed files
   (`ProjectIndex.productionCallableDefinitions({scope: file})`) whose leaf
   name does **not** appear (word-boundary) in the file's content at `base`
   (`git show <base>:./<file>`; command failure = file new at base = all its
   callables new). Cap at `maxHelpers` (default 10, mirrors `maxEchoChecks`).
3. **Wired-in evidence**: helper has ≥1 non-definition mention (any file —
   since the helper is new, every reference was added by this diff). Helpers
   with zero references are skipped (that territory belongs to the `new-dead`
   check) with a recorded skip reason.
4. **Fingerprint**: helper's meaningful-callee set; skip helpers with
   `< minCallees` (default 3) callees, recorded as skips (no silent caps).
5. **Leftover candidates**: every production callable fingerprint
   (`getAllCalleeFingerprints`, one scan per run) where:
   - candidate is not the helper and not in a changed file (touched files are
     the agent's active edit set — covered by review/echo),
   - candidate's callees do **not** include the helper (already migrated),
   - `containment(helper.callees, candidate.callees) ≥ minContainment`
     (default 0.7),
   - ≥1 shared callee is non-ubiquitous: document frequency over the corpus
     ≤ `max(8, ceil(sqrt(N)))` — the same rule `similarAll` uses for its
     inverted index (`similar.ts:156-167`). **Deviation from the original
     median-IDF design, found during fixture math:** the more sites a pattern
     was duplicated across, the more common its callees are in the corpus, so
     a median-IDF significance gate suppresses exactly the widespread-leftover
     case this detector targets. The ubiquity rule kills "every function calls
     the logger" overlap without punishing pattern-shared callees.
6. **Output**: per-helper finding listing migrated files and up to 5 leftover
   sites sorted by containment; result carries `available`, `base`,
   `changedFiles`, `helpersChecked`, `skipped[]`, `findings[]`.

Known limitation, documented in the module doc: helpers with fewer than 3
meaningful callees (tiny formatters) are not scored — callee evidence is too
thin; a source-token containment fallback is a follow-up if calibration shows
real misses.

## Phases

### Phase 1 — primitives + detector module

#### 1.1 — Add `containment` primitive

- [x] **File**: `src/analysis/similarity.ts:35-42` (insert after `jaccard`)
- **Source**: `scip-query code 'src/analysis/similarity.ts:1-120'`
- **What**: Module owns `intersection`, `difference`, `jaccard`, `computeIdf`,
  `getMedianIdf`, `weightedCosine`. No asymmetric measure.
- **Change**: Add `export function containment<T>(a: Set<T>, b: Set<T>): number`
  returning `|a∩b| / |a|`, 0 when `a` is empty. Update the module-header
  "honest scope" comment to mention the new consumer.
- **Why**: Correct score for "site contains helper's logic plus more".

#### 1.2 — Export fingerprint internals from similar.ts

- [x] **File**: `src/queries/similar.ts:217-222` (`SymbolFingerprint`),
  `:249` (`findCallees`), `:272` (`getAllCalleeFingerprints`)
- **Source**: `scip-query code 'src/queries/similar.ts:217-484'`
- **What**: All three are module-private; consumed only inside `similar.ts`.
- **Change**: Add `export` to the interface and both functions. No body changes.
- **Why**: Reuse over re-implementation; the new detector needs the same
  corpus and the same infrastructure-callee filtering.

#### 1.3 — New module `src/queries/incomplete-migration.ts`

- [x] **File**: `src/queries/incomplete-migration.ts` (new)
- **Source**: design above; patterns from `scip-query code
  'src/queries/recent-duplicates.ts:1-109'` (result shape, availability),
  `'src/queries/diff-impact.ts:176-199'` (git exec pattern),
  `'src/queries/diff-impact.ts:251-285'` (mentions SQL shape).
- **Change**: Implement `incompleteMigration(db, opts)` per the design, with
  `IncompleteMigrationFinding` / `IncompleteMigrationResult` interfaces,
  `opts = { base?, minContainment?, minCallees?, maxHelpers?, limit?, semantic? }`.
- **Why**: The detector itself.

### Phase 2 — diff-gate integration

#### 2.1 — Extend check union + docstring

- [x] **File**: `src/queries/diff-gate.ts:13-19` (union), `:39-57` (docstring)
- **Source**: `scip-query code 'src/queries/diff-gate.ts:1-228'`
- **Change**: Add `'incomplete-migration'` to `DiffGateCheck`; add a docstring
  bullet.

#### 2.2 — Add `runIncompleteMigrationCheck`

- [x] **File**: `src/queries/diff-gate.ts:85-86` (call site, after echo),
  new function after `runEchoCheck`
- **Source**: same as 2.1
- **Change**: Call `incompleteMigration(db, {base})`; map `available: false`
  to a `skipped` entry; map each finding to one `DiffGateFinding` naming the
  helper, migrated count, and leftover sites with containment percentages.
- **Why**: Diff-time enforcement is the point of the feature.

#### 2.3 — Update diff-gate descriptor description

- [x] **File**: `src/runtime/query-commands/impact.ts:116`
- **Source**: `scip-query code 'src/runtime/query-commands/impact.ts:80-142'`
- **Change**: Append the new check to the comma-separated check list in the
  description string.

### Phase 3 — CLI + packaging

#### 3.1 — Barrel export

- [x] **File**: `src/queries/index.ts:31` (insert near `diffGate`)
- **Source**: `scip-query code 'src/queries/index.ts:25-45'`
- **Change**: `export { incompleteMigration } from './incomplete-migration.js';`

#### 3.2 — Command descriptor + handler

- [x] **File**: `src/runtime/query-commands/impact.ts:90-141`
- **Source**: `scip-query code 'src/runtime/query-commands/impact.ts:1-142'`
- **Change**: `handleIncompleteMigration` (custom render mirroring
  `handleDiffGate`/`handleCoChange` style) + descriptor: id
  `incomplete-migration`, options `--base <ref>`, `--min-containment <n>`,
  `--max-helpers <n>`, `-n, --limit <n>`; `heuristic: { label: 'incomplete
  migration candidates' }`; description **must contain "candidate"**.

#### 3.3 — Command order

- [x] **File**: `src/runtime/query-command-specs.ts:49` (after `'diff-gate'`)
- **Source**: `scip-query code 'src/runtime/query-command-specs.ts:1-70'`
- **Change**: Insert `'incomplete-migration'`.

#### 3.4 — Public query manifest + package exports

- [x] **File**: `src/queries/public-query-entries.ts:41-42` (alphabetical:
  between `'imports'` and `'index'`); `package.json` `exports` (matching
  position)
- **Source**: `scip-query code 'src/queries/public-query-entries.ts:1-79'`;
  cli-contract lockstep test (direct inspection — tests not indexed).
- **Change**: Add `'incomplete-migration'` to `PUBLIC_QUERY_ENTRIES`; add
  `"./queries/incomplete-migration"` subpath export to package.json (copy the
  shape of an adjacent entry).

#### 3.5 — Regenerate command reference

- [x] **Command**: `npm run docs:commands`
- **Source**: package.json scripts; cli-contract "keeps command reference
  syntax generated from descriptors".

### Phase 4 — tests

#### 4.1 — `containment` unit tests

- [x] **File**: `tests/similarity.test.ts` (existing suite for the math module)
- **Change**: empty-A → 0; subset → 1; partial → fraction.

#### 4.2 — Detector integration test

- [x] **File**: `tests/incomplete-migration.test.ts` (new), modeled on
  `tests/git-history.test.ts` (temp git repo) + `tests/command-accuracy-fixtures.ts`
  (fixture project + DB with callee mentions).
- **Change**: Fixture: helper `formatThing` newly added to `src/util.ts` and
  referenced from `src/site-a.ts` (migrated); `src/site-b.ts` and
  `src/site-c.ts` contain the same callee set inline and don't reference the
  helper. Base commit lacks the helper; working tree has it. Assert:
  1. finding names the helper, the migrated file, and both leftovers;
  2. a candidate that references the helper is **not** reported;
  3. a candidate inside a changed file is **not** reported;
  4. helper with `< minCallees` callees lands in `skipped`, not `findings`;
  5. non-repo project root → `available: false`;
  6. diffGate surfaces an `incomplete-migration` finding from the same fixture.

### Phase 5 — verification

- [x] 5.1 `npm run typecheck` && `npm run lint`
- [x] 5.2 `npm test`
- [x] 5.3 `scip-query reindex` then `scip-query diff-gate` on this diff —
  must pass (or findings knowingly addressed)
- [x] 5.4 `scip-query health --baseline` — no new baseline findings
- [x] 5.5 `npm run docs:commands` output committed; cli-contract green

## Stress-test findings (11 principles)

1. **Understand before touching** — full reads of every touched function are
   cited above; the only semantic change to existing code is widening
   visibility (1.2) and a union member (2.1). ✓
2. **Blast radius** — `similar.ts` consumers: `diff-gate.ts`,
   `health-baseline.ts`, `health.ts`, `recent-duplicates.ts`,
   `runtime/query-commands/cleanup.ts`, barrel (Source: `scip-query surface
   src/queries/similar.ts`). Adding exports breaks none. `DiffGateCheck`
   union consumers: only diff-gate itself + impact.ts renderer, which prints
   `finding.check` generically — no exhaustive switch anywhere (Source:
   `scip-query refs diffGate`). ✓
3. **Valid intermediate states** — phases 1→4 each compile independently;
   the detector is callable before it's registered, registered before
   documented. The contract test ties manifest/package.json/docs together, so
   3.4 + 3.5 must land in the same commit as 3.2/3.3. Noted in ship order.
4. **Reversibility** — all two-way doors except the npm subpath export
   (`./queries/incomplete-migration`), which becomes public API on the next
   publish. Acceptable: every query module ships this way by policy.
5. **Design for failure** — git unavailable / not a repo → `available:
   false` result and a `skipped` gate entry (pattern proven by
   `recentDuplicates` and `runCoChangePartnerCheck`). `git show` failure per
   file = file-new-at-base, which is the conservative direction (more
   candidates checked, none invented: a "new" helper still needs real
   references and real containment to fire). Stale index → helper absent
   from DB → no finding; same failure mode as every diff query here, already
   documented behavior.
6. **Concurrency** — read-only over SQLite + git; no shared mutable state;
   caches in git-history are per-head keyed (existing design). ✓
7. **Boundaries** — CLI input is a git ref passed to `execFileSync` argv
   (no shell), same trust level as existing `--base` handling. ✓
8. **Data integrity** — no writes. ✓
9. **Observability** — `skipped[]` with reasons on both the standalone result
   and the gate result; no silent caps (`maxHelpers` overflow recorded, like
   the echo check's skip entry). ✓
10. **Human experience** — gate message names the helper, the wired sites,
    the leftover sites, and percentages; remediation says exactly what to do
    ("migrate the remaining sites or confirm they're intentionally
    different"). False-positive escape hatch: thresholds are flags; the gate
    is advisory-exit-1 like every other gate finding.
11. **Reuse / match existing code** — see Gate C table; the only
    re-implemented shape is the small mentions query (justified: existing
    helpers exclude the wrong direction). Module/doc/test style mirrors
    `recent-duplicates.ts` throughout.

## Execution + ship order

Phase 1 → 2 → 3 → 4 → 5, single PR. Phases 3.2–3.5 are atomic (contract
test). No one-way doors before publish; the npm export ships with the next
version bump.

## Summary

- **New**: `src/queries/incomplete-migration.ts`,
  `tests/incomplete-migration.test.ts`, this plan.
- **Modified**: `src/analysis/similarity.ts`, `src/queries/similar.ts`,
  `src/queries/diff-gate.ts`, `src/queries/index.ts`,
  `src/queries/public-query-entries.ts`,
  `src/runtime/query-commands/impact.ts`,
  `src/runtime/query-command-specs.ts`, `package.json`,
  `docs/COMMAND_REFERENCE.md` (generated), `tests/similarity.test.ts`.
- **Net delta**: ~+450 LOC (module ~180, tests ~200, plumbing ~70).
