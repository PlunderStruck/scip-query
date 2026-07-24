# Maintainability Baseline Reconciliation

Date: 2026-07-23

## Goal

Reconcile every maintainability candidate currently reported by
`health --baseline`: repair candidates whose concrete code shape invites a
future maintenance mistake, retain intentional workflow and contract shapes,
attach detector-specific source rationales to every accepted candidate, and
leave a version-independent baseline that fails only when a new, unreviewed
candidate appears.

Done means:

1. every pre-audit identity has a disposition in the companion candidate
   register;
2. accepted candidates have a concrete reason tied to their code referents;
3. implemented fixes preserve behavior, watcher/worktree correctness, and
   indexing performance;
4. a package-version-only index change cannot churn baseline identities; and
5. `health --baseline`, architecture, and `diff-gate` all pass from a fresh
   index.

## Definitions and invariants

A **maintainability candidate** is a detector-produced code location or pair
whose observable structure predicts that a future maintainer may need to
rediscover, synchronize, or defend knowledge. Its referents are the 254
uncapped `extract`, `stale`, `duplicate-bodies`, `similar`, `passthrough`, and
`wrapper` rows reviewed here. The prediction makes it a review lead; it is not
itself proof of a defect. Sources: the six detector commands with `--full`;
the default health view is capped and exposed only the first 107 rows.

A **legitimate candidate** is a maintainability candidate whose cited units
share one behavior, policy, lifecycle, or ownership rule and whose current
separation or indirection creates a concrete future-change failure. The
unifying rule, rather than detector volume or line count, makes repair useful.
Source: `node dist/cli.js extract-candidates --json`,
`stale-abstractions --json`, `duplicate-bodies --json`,
`similar --json`, `passthrough-candidates --json`, and
`wrapper-candidates --json`.

An **accepted signal** is a maintainability candidate whose measured shape is
caused by an intentional workflow, protocol, compatibility boundary, or
essential platform variation. Preserving the named rule is what distinguishes
acceptance from neglect. Its detector-specific rationale remains beside the
exact source declaration, and its disposition remains in the candidate
register.

A **stable baseline identity** is a detector-and-referent key whose equality
depends on repository-relative code identity, not the package version embedded
in a SCIP symbol. Package-version independence is what lets the baseline act
as a code-change ratchet rather than a release-number detector. Its referents
are the pair identities currently built from `symbolA`, `symbolB`, and
`DuplicateBodyEntry.symbol`. Source:
`node dist/cli.js code collectBaselineFindings --json` and
`node dist/cli.js code SimilarSymbolResult --json`.

A **baseline ratchet** is the committed set of reviewed identities that
rejects a current identity iff that identity is absent from the reviewed set.
Its one writer is `writeHealthBaseline`; its readers are
`checkHealthBaseline` and `checkArchitectureBaseline`, reached through the
health CLI and diff gate. Source:
`node dist/cli.js trace writeHealthBaseline --json`,
`trace checkHealthBaseline --json`, and
`trace checkArchitectureBaseline --json`.

The following invariants must always hold:

- I1. Two indexes of the same source tree that differ only in package version
  must produce equal health baseline identities.
- I2. A legacy baseline containing full SCIP symbols must compare as though
  those symbols had been shortened to stable repository identities.
- I3. An identity is accepted iff its candidate register entry has an
  evidence-backed `accept` disposition and the exact source referent has a
  detector-specific suppression with the same rationale.
- I4. An identity is removed iff the underlying candidate was repaired or
  detector evidence no longer reproduces.
- I5. Architecture identities and the architecture-only diff-gate path must
  remain byte-for-byte independent of non-architecture identity
  normalization.
- I6. A workflow or protocol contract must not be split or relocated merely
  to reduce a heuristic count; a refactor must remove duplicated policy,
  unnecessary indirection, or an unrelated reason to change.
- I7. Watcher/worktree behavior, incremental indexing behavior, and measured
  hot-path reuse must remain behaviorally unchanged by maintainability fixes.

## Premises

- P1. The index is fresh for 347 source files, TypeScript and Rust semantic
  providers are available, and the linked-worktree watcher is running and
  idle. Source: `node dist/cli.js status --capabilities`.
- P2. The default health comparison is capped at 107 candidates, but uncapped
  detector runs contain 254: 195 extraction signals, 52 stale-abstraction
  signals, 3 duplicate-body pairs, 2 similar pairs, 1 passthrough, and 1
  wrapper. They contain no architecture, cycle, dead, isolated, or drift
  identities. Source: `health --baseline --json` plus each maintainability
  detector with `--full`.
- P3. `collectBaselineFindings` currently embeds full, versioned SCIP symbols
  in `similar` and `duplicate-bodies` identities, while all other relevant
  detector identities use stable file and short-name fields. Source:
  `node dist/cli.js code collectBaselineFindings --json`.
- P4. `SimilarSymbolResult` already exposes `fileA`, `shortNameA`, `fileB`, and
  `shortNameB`; duplicate-body entries already expose `file` and `shortName`.
  No detector result contract needs to change. Source:
  `node dist/cli.js code SimilarSymbolResult --json` and
  `node dist/cli.js outline src/queries/cleanup/duplicate-bodies.ts --json`.
- P5. `shortenSymbol` is the existing parser-backed mechanism that turns a
  full SCIP symbol into the same repository-qualified short name already
  carried by detector rows. Source:
  `node dist/cli.js trace shortName --json` plus the executed
  `shortenSymbol` compatibility probe.
- P6. The baseline file has one writer, `writeHealthBaseline`, invoked by the
  health command handler. Full health reads it through `checkHealthBaseline`;
  architecture gating reads it through `checkArchitectureBaseline`.
  Source: `node dist/cli.js trace writeHealthBaseline --json`,
  `trace checkHealthBaseline --json`, and
  `trace checkArchitectureBaseline --json`.
- P7. The baseline module has three external consumers and medium change
  surface: query exports, the health command handler, and diff gate. Source:
  `node dist/cli.js plan-context src/queries/health/health-baseline.ts --json`.
- P8. The committed baseline was last reconciled for release 0.10.4 and its
  only stored symbol identity embeds `0.10.4`. Source:
  `git log --follow -- .scipquery-baseline.json` and
  `.scipquery-baseline.json`.
- P9. Existing baseline behavior is exercised through
  `tests/queries/health/debloat-health.test.ts`, and full-baseline collection
  is exercised through
  `tests/queries/impact/incomplete-migration.test.ts`. Tests are not present
  in the production SCIP shard, so this premise uses the narrow fallback
  search `rg -n "writeHealthBaseline|checkHealthBaseline|collectBaselineFindings" tests`.
- P10. `stale-abstractions` and `wrapper-candidates` are exploration-only on
  codebases with intentional layering; extraction rows label orchestration
  cases as signals and explicitly recommend preserving a workflow when its
  sequence is the concept. Source: bundled `_shared` and
  `scip-maintainability` skill reliability contracts plus
  `node dist/cli.js extract-candidates --json`.

## Current state

The baseline writer snapshots every current identity as a version-1 string
array (P6). Full health compares that array to a freshly collected set, while
the architecture path filters the same array to architecture-prefixed
identities (P6). Pair detectors currently serialize compiler package metadata
into their identities even though their result contracts already expose
stable repository names (P3, P4). The committed snapshot predates eight minor
release lines and therefore neither represents the present code nor survives
version-only symbol churn (P8).

The 254 rows are dominated by two low-confidence structural probes (P2, P10).
They require a role inventory, not mechanical extraction or type relocation.
The small duplicate, similar, passthrough, and wrapper set can be reviewed
individually; every retained row must state why its variation or boundary is
essential (I3, I6).

## Reuse audit

| Need                                             | Reuse decision                                                                                                    | Evidence |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------- |
| Convert legacy full SCIP symbols to stable names | Reuse `shortenSymbol`; do not add a parser                                                                        | P5       |
| Identify current pair referents                  | Reuse `file*` and `shortName*` fields already returned by detectors                                               | P4       |
| Store accepted standing signals                  | Use detector-specific source comments so every exception remains attached to its exact referent                   | P2, P10  |
| Explain accepted standing signals                | Add one companion Markdown register that reconciles the complete uncapped inventory                               | P2, P8   |
| Audit workflow extraction                        | Reuse detector cluster/evidence output and existing feature-local helpers; add no generic orchestration framework | P10      |

One local identity-normalization helper in `health-baseline.ts` is justified:
both the writer/current collector and all baseline readers must apply exactly
one normalization rule, including legacy inputs. Duplicating that parsing at
each reader would recreate the policy defect.

## Testability design

| Behavior                          | Test seam                                                                       | Dependencies                     | Pure core                        | Side-effect shell               | Contract                                                      |
| --------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- | -------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| Version-independent identity      | exported-for-test or module-local normalization exercised through baseline APIs | none                             | normalize one identity string    | none                            | legacy and stable strings compare equal                       |
| Baseline write/read compatibility | `writeHealthBaseline` then `checkHealthBaseline` in fixture DB                  | temp filesystem and fixture DB   | normalized set comparison        | baseline file read/write        | no new/fixed rows for equal referents                         |
| Architecture isolation            | `checkArchitectureBaseline` fixture                                             | temp baseline and fixture DB     | prefix filtering                 | baseline read                   | non-architecture normalization cannot alter architecture rows |
| Candidate repair                  | focused detector and existing feature tests                                     | fixture DB where required        | candidate-specific policy        | existing command/provider shell | repaired identity disappears without behavior drift           |
| Reviewed acceptance               | source-suppression count, candidate register, and final baseline comparison       | repository files and fresh index | identity-to-disposition coverage | baseline write                  | every accepted identity is suppressed at its exact referent   |

## Design phases

### 1.1 — Stabilize pair identities

- [x] **File**: `src/queries/health/health-baseline.ts:63-179`
- **Premises**: P3, P4, P5, P6
- **Deployable**: yes
- **Change**: Build new similar and duplicate-body identities from stable
  short names; normalize legacy stored identities through `shortenSymbol`
  before comparison. Keep all non-pair and architecture identities unchanged.
- **Testability**:
  - Test seam: baseline collection and comparison APIs.
  - Injected dependencies: existing fixture DB and temp baseline path.
  - Pure core: identity normalization.
  - Side-effect shell: existing baseline read/write.
  - Contract: I1, I2, I5.
- **Validation**: focused health-baseline tests, typecheck, and a
  version-substitution regression.
- **Why**: The existing parser already supplies the required stable identity;
  reusing it removes release-number churn without altering detector behavior
  (P3-P5).

### 2.1 — Build the complete disposition register

- [x] **File**:
      `docs/plans/2026-07-23-maintainability-candidate-register.md`
- **Premises**: P1, P2, P10
- **Deployable**: yes
- **Change**: Record every current stable identity with detector, referents,
  unifying definition or essential-variation reason, strongest dissenter,
  disposition, and validation. Counts must reconcile to the executed
  candidate inventory.
- **Testability**:
  - Test seam: identity/count reconciliation against fresh detector output.
  - Injected dependencies: fresh repository index.
  - Pure core: set difference between inventory and register.
  - Side-effect shell: Markdown register.
  - Contract: I3, I4, I6.
- **Validation**: no missing or duplicate identity; category totals equal the
  current audit set.
- **Why**: The baseline can enforce identity membership but cannot explain
  intentional structure (P2, P10).

### 3.1 — Repair validated small candidates

- [x] **Files**: exact files selected by phase 2.1
- **Premises**: P2, P10 and candidate-specific register evidence
- **Deployable**: yes, one focused repair at a time
- **Change**: Inline a truly unnecessary wrapper, merge duplicated policy, or
  remove an accidental passthrough only where the register proves a shared
  concept and no boundary contract.
- **Testability**:
  - Test seam: existing detector plus focused feature tests.
  - Injected dependencies: existing test seams only.
  - Pure core: shared policy when one actually exists.
  - Side-effect shell: unchanged command/provider boundary.
  - Contract: I4, I6, I7.
- **Validation**: focused tests and routed postchecks for wrappers,
  passthroughs, helpers, and deletions.
- **Why**: Small direct candidates can remove concepts with low blast radius,
  but detector labels alone do not authorize consolidation (P10).

### 3.2 — Repair validated workflow or contract candidates

- [x] **Files**: exact files selected by phase 2.1
- **Premises**: candidate-specific register evidence and P10
- **Deployable**: yes, or one explicitly named single-deploy group where a
  contract and all consumers must move together
- **Change**: Extract only a stable feature-local lifecycle or relocate only a
  type whose defining module does not own its contract. Preserve
  orchestration order and public/protocol ownership.
- **Testability**:
  - Test seam: existing workflow/protocol entry point.
  - Injected dependencies: existing provider/runtime contracts.
  - Pure core: named lifecycle decision, if found.
  - Side-effect shell: unchanged process/filesystem/LSP boundary.
  - Contract: I6, I7.
- **Validation**: focused lifecycle tests, full test suite, and performance
  contract tests for any hot-path edit.
- **Why**: These rows are signals; a change is valid only when it reduces a
  real reason to change rather than shortening a function or moving a type
  aesthetically (P10).

### 4.1 — Suppress the reviewed remainder and reset the ratchet

- [x] **Files**: exact source declarations, `.scipquery-baseline.json`, and
      the candidate register
- **Premises**: P2, P6, completed phases 2.1-3.2
- **Deployable**: yes
- **Change**: Attach each accepted reason to its exact source declaration,
  write the baseline from the repaired and suppressed tree, verify that no
  reviewed identity remains visible, and record final fixed/accepted counts.
- **Testability**:
  - Test seam: `health --baseline`.
  - Injected dependencies: fresh index.
  - Pure core: uncapped detector and register reconciliation.
  - Side-effect shell: committed baseline.
  - Contract: I3-I5.
- **Validation**: every uncapped maintainability detector returns zero;
  `health --baseline --json` exits zero with no fixed or new identities; and
  architecture remains zero.
- **Why**: Writing the baseline before the audit would convert unreviewed
  leads into unexplained permanent debt (I3).

## Attack record

### A1. I1 via release-version churn

- **Attack**: A maintainer publishes a patch release, reindexes identical
  source, then runs `health --baseline`; versioned pair symbols compare
  unequal.
- **Outcome**: HOLE — repaired by step 1.1 using P3-P5.

### A2. I2 via legacy repository upgrade

- **Attack**: A repository created its baseline with 0.10.4, upgrades to the
  fixed release, and compares without rewriting the file first.
- **Outcome**: HOLE — repaired by step 1.1; readers normalize legacy entries
  before set comparison (P5, P6).

### A3. I5 via shared-file normalization

- **Attack**: Non-architecture normalization accidentally rewrites or drops an
  `architecture:` identity before `checkArchitectureBaseline` filters it.
- **Outcome**: HELD — step 1.1 must pass architecture strings through
  unchanged and prove that through the architecture test seam (P6).

### A4. I3 via blind baseline rewrite

- **Attack**: An operator runs `--write-baseline` immediately and accepts the
  capped 107-row page while never discovering the other 147 rows.
- **Outcome**: HOLE — repaired by steps 2.1 and 4.1; set reconciliation requires
  every retained identity to have a register disposition (P2).

### A5. I6 via extraction-count optimization

- **Attack**: A maintainer splits `diffGate`, a watcher loop, or an LSP request
  pipeline solely because it is long, scattering the ordered lifecycle across
  helpers without naming a distinct policy.
- **Outcome**: HELD — step 3.2 requires a unifying lifecycle definition and
  keeps orchestration intact otherwise (P10).

### A6. I6 via single-consumer type relocation

- **Attack**: A protocol result type is moved beside its one current consumer,
  so the consumer rather than the protocol owner defines valid states.
- **Outcome**: HELD — step 3.2 accepts the row when the defining file owns the
  contract and relocates only when ownership evidence disproves that (P10).

### A7. I7 via hot-path helper consolidation

- **Attack**: Two similar indexing or semantic paths are merged and lose their
  distinct cache, fallback, or concurrency constraints.
- **Outcome**: HELD — phases 2.1 and 3.2 preserve essential variation and
  require focused performance/lifecycle tests before consolidation (P1, P10).

### A8. I4 via detector-only disappearance

- **Attack**: Reindexing or an identity-format change makes a candidate vanish
  without changing its code, and the audit counts it as repaired.
- **Outcome**: HELD — step 1.1 stabilizes identity first; step 4.1 counts a fix
  only after the candidate-specific detector no longer reproduces it (P3,
  P4).

### Coverage matrix

| Surface or lens                                  | Attacks    |
| ------------------------------------------------ | ---------- |
| Baseline writer: `writeHealthBaseline`           | A1, A4     |
| Full baseline reader: `checkHealthBaseline`      | A1, A2, A8 |
| Architecture reader: `checkArchitectureBaseline` | A3         |
| Purpose and data integrity                       | A1, A4, A8 |
| Blast radius and boundaries                      | A3, A6     |
| Valid intermediate state                         | A4         |
| Reversibility                                    | A2, A4     |
| Failure and observability                        | A1, A8     |
| Efficiency                                       | A7         |
| Reuse                                            | A2, A5     |
| Testability                                      | A1-A3, A8  |
| Human review experience                          | A4-A6      |

## Execution and ship order

1. Stabilize and test identity normalization.
2. Regenerate the stable inventory.
3. Complete the candidate register before maintainability edits.
4. Apply small direct repairs, then any proven workflow/contract repairs.
5. Reindex between candidate families so detector disappearance is
   attributable.
6. Write the reviewed baseline only after the register and code converge.
7. Run focused postchecks, full tests, typecheck, lint, build, reindex,
   architecture, `health --baseline`, and `diff-gate`.

The only one-way door is writing an unexplained baseline. Step 4.1 is therefore
last and is reversible through the candidate register and Git.

## Verdict

A plan is `PLANNED-COMPLETE` iff the coverage matrix has no blank rows, every
attack ends in `HELD` with cited steps and premises or an accepted hole with a
written reason, and no premise failed reverification.

Result: **PLANNED-COMPLETE** — 8 attacks, 4 holes repaired by planned steps,
0 holes accepted, and no unresolved premise.

## Implementation result

Status: **IMPLEMENTED AND VERIFIED**

- `normalizeBaselineFindingIdentity` now converts versioned `similar` and
  `duplicate-bodies` symbols into sorted repository-qualified identities.
  Current and legacy stored identities pass through the same normalization
  rule; architecture identities remain unchanged.
- The full 254-row uncapped inventory is adjudicated in the companion
  register. One empty facade, `computeReindexFingerprint`, was inlined into
  its existing profile span. The other 253 rows are accepted with
  detector-specific source rationales.
- `.scipquery-baseline.json` contains no accepted maintainability identities:
  accepted rows are filtered at their exact source referents. The baseline
  remains the executable ratchet for any new unsuppressed identity.
- No workflow or contract extraction passed the phase 3.2 ownership test.
  Completing that phase therefore meant preserving the reviewed operations,
  not changing code to lower a detector count.

Executed evidence:

- Focused health-baseline regression: 8 tests passed, including package
  version, pair-order, already-normalized, duplicate-body, and architecture
  cases.
- Full suite: 201 files and 1,416 tests passed with normal cache and watcher
  permissions.
- `npm run typecheck`, `npm run lint`, and `npm run build`: passed.
- `scip-query reindex`: fresh/reused current index.
- `recent-duplicates`: 0 findings.
- `passthrough-candidates`: 0 findings.
- `cleanup-plan --verify`: no deletion cascade.
- `co-change .scipquery-baseline.json`: 0 findings.
- Uncapped extraction, stale-abstraction, duplicate-body, similarity, wrapper,
  and passthrough detectors: 0 unsuppressed findings.
- `health --baseline`: 0 current maintainability identities, 0 new, 0 fixed.
- `diff-gate`: exit 0 with all nine checks enabled, no unsuppressed findings,
  and 23 structured suppressions. The 17 suppressions created by this slice
  record annotation-only co-change and documentation signals whose linked
  behavior and citations remained unchanged; six earlier project
  suppressions also remain effective.

Refutation attempts:

- R1 — Substitute package versions, reverse a symbol pair, and renormalize an
  already-stable identity: survived in the focused regression test.
- R2 — Remove the facade but preserve fingerprint semantics: survived the
  zero-passthrough check, project fingerprint tests, reindex reliability
  tests, worktree cache integration tests, and the full suite.

## Expected files

- Create:
  `docs/plans/2026-07-23-maintainability-candidate-register.md`
- Edit: `src/queries/health/health-baseline.ts`
- Edit: focused health-baseline and candidate-specific tests
- Edit: exact code files selected by the complete register
- Rewrite after audit: `.scipquery-baseline.json`
- Verify: detector outputs, architecture, full health baseline, and diff gate
