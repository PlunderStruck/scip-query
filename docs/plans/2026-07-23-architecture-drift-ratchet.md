# Architecture-Aware Drift and Ratchet

Date: 2026-07-23

## Outcome

Make `drift` evaluate the repository's declared architecture instead of a
scip-query-specific directory table, and make `diff-gate` reject newly
introduced declared architecture violations without forcing an established
repository to repair all of its existing dependency debt first.

This is the enforcement slice of
`docs/architecture-coherence-vision.md`. It reuses the architecture report and
the existing health-baseline file; it does not infer an ideal architecture,
automatically rewrite configuration, or turn reciprocal/cycle signals into
failures.

## Start Status

`scip-query status --capabilities` reports a fresh compiler-backed index for
342 files.

`scip-query plan-context` and `scip-query refs` establish these current seams:

- `src/queries/cleanup/drift.ts` owns the drift pipeline and is consumed by
  health, health-baseline, the public API, and the CLI handler.
- `src/queries/cleanup/drift-policy.ts` is the only source of the hardcoded
  directory policy. Its explicit and inferred results are currently combined
  with unused-import and opt-in pattern-deviation results.
- `src/queries/graph/architecture.ts` already turns file import facts and
  project configuration into boundary edges classified as allowed, forbidden,
  or undeclared.
- `src/queries/health/health-baseline.ts` is the single writer and comparison
  seam for `.scipquery-baseline.json`.
- `src/queries/impact/diff-gate.ts` is the single executor for diff checks;
  `DIFF_GATE_CHECKS` is its canonical check registry and is also read by CLI
  validation and the public query index.
- `src/queries/impact/diff-gate-baseline-policy.ts` turns stable baseline
  identities into user-facing diff-gate evidence.

## Definitions and Sources

An architecture violation is a dependency between two named code
responsibilities that an explicit project-owned rule rejects. The real-world
referents are import edges such as a persistence file importing an analysis
file; it belongs to the wider class of dependency edges and differs from the
others because its importing boundary has a closed allow-list that omits the
imported boundary. `src/queries/graph/architecture.ts` is the source of this
classification.

An architecture signal is graph evidence that can prompt design investigation,
such as reciprocal boundary traffic or a multi-boundary cycle. It belongs to
the wider class of analyzer observations and differs from a violation because
no declared rule is contradicted. The architecture report is its source; the
diff gate must not promote it into a failure.

A baseline identity is a stable string naming one accepted analyzer result. Its
real-world referent is a committed entry in `.scipquery-baseline.json`; it
belongs to the wider class of persistent comparison keys and differs from
display evidence because it survives example-file ordering and ordinary report
format changes. `src/queries/health/health-baseline.ts` is its authority.

A ratchet is a comparison gate that permits the recorded state and rejects new
instances. Its real-world referent is the set difference between current
architecture identities and committed architecture identities; it belongs to
the wider class of regression checks and differs from an absolute conformance
gate because existing debt does not fail merely by existing.

## Premises

**P1. Architecture judgment must come from project configuration.** Directory
names and import rarity are facts, but they do not establish what the
repository intends to forbid.

**P2. A closed dependency row is the enforcement threshold.** A missing row
means the responsibility has not been declared mature enough to judge;
therefore undeclared edges remain visible but non-blocking.

**P3. Boundary pairs are the stable unit of architectural debt.** Individual
file examples can move during a refactor while the same responsibility-level
violation remains. The baseline must therefore name `from -> to`, not whichever
file edge sorts first.

**P4. Existing debt needs a ratchet, not an all-at-once migration.** A large
repository must be able to record current direct violations and block only new
ones.

**P5. Architecture signals are not rule violations.** Reciprocity and strongly
connected components inform boundary design, but absent an explicit
`requireAcyclic` rule they cannot fail drift or diff-gate.

**P6. One baseline store is enough.** `.scipquery-baseline.json` already has a
writer, reader, public command, and diff-gate integration; a second
architecture-specific baseline would create split state authority.

**P7. The default architecture gate should be narrow.** Running every health
detector just to compare architecture would turn an inexpensive dependency
contract into a full-repository analysis.

**P8. The full baseline and the dedicated architecture check must not report the
same identity twice.** The dedicated check owns architecture findings inside
`diff-gate`; the optional full baseline owns all remaining detector identities.

## Invariants

1. An unconfigured repository produces no architecture violations and the
   architecture diff check reports why it did not run.
2. An outgoing edge from a boundary without an `allowedDependencies` row is
   undeclared, not forbidden.
3. A present row is closed: every unlisted cross-boundary target is forbidden.
4. Drift emits at most one direct architecture result per forbidden boundary
   pair and retains representative file-edge evidence.
5. Architecture baseline identities depend only on canonical boundary names
   and rule kind.
6. Reciprocal pairs and cycles are report-only unless the corresponding
   project-owned rule explicitly makes them violations.
7. Existing architecture identities in the committed baseline do not fail
   `diff-gate`; new identities do.
8. `diff-gate --baseline` does not duplicate findings already owned by the
   default architecture check.
9. Unused-import and opt-in pattern-deviation behavior remains available.
10. The hardcoded scip-query layer table and its private package manifest entry
    no longer exist.

## State Authority and Reuse Audit

| State or behavior | Writer/producer | Readers/consumers | Decision |
| --- | --- | --- | --- |
| File import graph | `buildFileDepGraph()` | `architecture()` | Reuse unchanged. |
| Architecture policy | `.scipquery.json` through runtime config validation | `ScipDatabase.config`, `architecture()` | Reuse as the only policy authority. |
| Architecture findings | `architectureFindingIdentities()` in the graph query | health baseline and architecture diff check | Add one pure identity seam beside the report. |
| Baseline file | `writeHealthBaseline()` / `health --write-baseline` | `checkHealthBaseline()`, new narrow architecture comparison, diff-gate | Reuse; do not create a second baseline. |
| Diff checks | `DIFF_GATE_CHECKS` and `diffGate()` | CLI skip validation, public API, result output | Add `architecture` as a normal default check. |
| User-facing baseline evidence | `baselineFindingMetadata()` | `runBaselineCheck()` and architecture check | Extend for architecture identity grammar. |
| Agent workflow | `skills/scip-directory-architecture/SKILL.md` | Codex agents applying the tool | Extend the existing skill; do not add a competing skill. |

## Testability Design

| Behavior | Pure seam or fixture | Required assertion |
| --- | --- | --- |
| Stable identities | `architectureFindingIdentities()` unit test | Same boundary pair yields the same identity despite example-file changes. |
| Closed-row drift | Configured graph fixture | One direct grouped result appears for a forbidden pair. |
| Unconfigured safety | Existing unconfigured fixtures | No inferred/hardcoded layer result appears. |
| Undeclared edge safety | Configured graph with missing row | Edge stays visible only in the architecture report. |
| Existing-debt ratchet | Temporary git/index fixture plus baseline | Recorded identity produces no diff-gate finding. |
| New-debt rejection | Same fixture without identity | New forbidden pair produces one blocking direct finding. |
| Missing baseline | Same fixture without baseline file | Architecture check is skipped with an enabling instruction. |
| Full-baseline ownership | Diff-gate integration test | `--baseline` does not emit a second architecture finding. |
| CLI report | CLI contract and handler tests | `drift --architecture` exposes policy coverage and signals without changing their tier. |
| Project adoption | Repository dogfood run | Current direct violations are recorded and a fresh run passes. |

## Implementation Steps

### 1. Replace drift's local policy with the architecture query

Files:

- `src/queries/cleanup/drift.ts`
- delete `src/queries/cleanup/drift-policy.ts`
- `src/queries/health/health-types.ts`
- `src/queries/health/health.ts`
- `tests/queries/cleanup/drift-policy.test.ts`
- `tests/queries/navigation/queries-advanced.test.ts`
- `tests/queries/graph/graph-risk-output.test.ts`
- `tests/runtime/cli-contract.test.ts`

Changes:

- Remove hardcoded and rare-edge layer inference.
- Convert each configured forbidden boundary edge into one direct
  `architecture-violation` drift result.
- Preserve representative file edges, breadth counts, and a deprecated
  `layerViolations` summary alias for API compatibility.
- Keep sibling-pattern deviation opt-in, without treating project-local
  dependency pairs as implicitly safe.
- Update health wording and tests to describe declared architecture
  violations.

Premises: P1-P3, P5.

### 2. Add stable architecture identities to the existing baseline

Files:

- `src/queries/graph/architecture.ts`
- `src/queries/health/health-baseline.ts`
- `src/queries/impact/diff-gate-baseline-policy.ts`
- `tests/queries/graph/architecture.test.ts`
- baseline-policy tests

Changes:

- Add deterministic identities for forbidden boundary pairs and explicitly
  forbidden cycles.
- Include those identities in health baseline collection independently of
  drift's example files.
- Add metadata that explains the boundary pair and gives direct remediation.
- Add a narrow comparison that filters the shared baseline and current report
  to architecture identities only.

Premises: P3, P6, P7.

### 3. Make architecture a default diff-gate ratchet

Files:

- `src/queries/impact/diff-gate.ts`
- `src/runtime/query-commands/impact.ts`
- new focused diff-gate integration test

Changes:

- Add `architecture` to the canonical check registry and run it by default.
- Skip clearly when configuration, enforceable rules, or baseline state is
  absent.
- Emit blocking direct findings only for identities absent from the committed
  baseline.
- Filter architecture identities out of the optional full-baseline check so
  ownership is singular.

Premises: P4, P6-P8.

### 4. Expose architectural context through drift

Files:

- `src/runtime/query-commands/cleanup/descriptors.ts`
- `src/runtime/query-commands/cleanup/handlers.ts`
- generated `docs/COMMAND_REFERENCE.md`
- generated `skills/_shared/SKILL.md`

Changes:

- Add `drift --architecture`.
- Keep direct violations in ordinary drift output; use the flag to append
  mapping coverage, policy coverage, reciprocal pairs, and cycles.
- Update command descriptions so the tool no longer claims inferred layer
  policy.

Premises: P1, P5.

### 5. Dogfood a conservative repository policy and ratchet

Files:

- `.scipquery.json`
- `.scipquery-baseline.json`
- `skills/scip-directory-architecture/SKILL.md`
- `docs/architecture-coherence-vision.md`
- affected configuration/manifest tests

Changes:

- Close only responsibilities with obvious dependency direction:
  `domain`, `instrumentation`, and `rust-kernels` depend on no internal
  boundaries; `storage` may depend on `domain` and the dependency-free
  profiling instrumentation primitive.
- Remove the obsolete coverage contract that polices the deleted hardcoded
  layer table.
- Record current direct architecture identities alongside the existing health
  identity.
- Explain descriptive discovery, closed-row declaration, baseline creation,
  default diff enforcement, and migration in the existing architecture skill.

Premises: P2, P4, P6.

### 6. Verify

```bash
npm run typecheck
npx vitest run tests/queries/graph/architecture.test.ts \
  tests/queries/navigation/queries-advanced.test.ts \
  tests/queries/graph/graph-risk-output.test.ts \
  tests/queries/impact/architecture-ratchet.test.ts \
  tests/runtime/runtime-config.test.ts \
  tests/runtime/cli-contract.test.ts
npm run docs:commands
npm test
npm run lint
scip-query config-validate
scip-query reindex
scip-query recent-duplicates
scip-query co-change src/queries/cleanup/drift.ts
scip-query co-change src/queries/health/health-baseline.ts
scip-query diff-gate
```

## Falsification Attacks

| Attack | Result | Repair or proof |
| --- | --- | --- |
| A1. Run drift in a repository whose folders happen to be named `core`, `app`, or `infra`. | Held. | No configuration means no architecture rule and therefore no violation. |
| A2. Configure descriptive boundaries but omit all dependency rows. | Held. | Every cross-boundary edge remains `undeclared`; drift emits no direct architecture results. |
| A3. Adopt rules in a mature repository with three existing violations. | **HOLE found.** | An absolute gate would fail adoption immediately. Repaired by comparing stable identities to the existing committed baseline. |
| A4. Run the default diff gate on a large index. | **HOLE found.** | Calling `checkHealthBaseline()` would run every detector. Repaired with a narrow architecture-only comparison against the same file. |
| A5. Move the representative importing file while preserving the same forbidden boundary pair. | Held. | Identity is `architecture:forbidden-edge:<from>:<to>`, not a file pair. |
| A6. Add a new forbidden pair without touching architecture config. | Held. | Current identity is absent from baseline and becomes one blocking direct diff-gate finding. |
| A7. Observe a reciprocal pair whose rows are undeclared. | Held. | It remains an architecture signal and produces no baseline identity. |
| A8. Run the gate before creating a baseline. | Held. | The architecture check skips with `health --write-baseline`; it does not pretend that no policy regression exists. |
| A9. Enable `diff-gate --baseline` when architecture already has a new identity. | **HOLE found.** | Both checks would report the same debt. Repaired by assigning architecture identities exclusively to the dedicated check inside diff-gate. |
| A10. Delete the policy implementation but leave config tests, coverage contracts, or private-surface manifests naming it. | Held by planned checks. | Search and CLI contract assertions remove every stale reference. |
| A11. Add an acyclicity rule later. | Held. | Canonically sorted boundary sets provide stable explicit cycle identities; cycles remain signals while `requireAcyclic` is absent or false. |
| A12. Suppress a specific new architecture finding. | Held. | The finding uses the ordinary deterministic diff-gate ID and passes through the existing structured suppression pipeline. |

Repaired holes: 3. Unrepaired blocking holes: 0.

## Verdict

**PLANNED-COMPLETE.**

The design has one policy authority, one baseline authority, stable
responsibility-level identities, a narrow default regression check, and a safe
adoption path for large existing repositories. Implementation may proceed.
