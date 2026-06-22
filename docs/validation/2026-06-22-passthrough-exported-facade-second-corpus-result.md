# Passthrough Exported Facade Second-Corpus Result

Date: 2026-06-22

## Verdict

The passthrough exported-facade second-corpus slice is complete.

An exported facade is a named callable that callers can reach through a package surface or configured/framework entry surface and whose body mostly delegates to implementation code. It is still a passthrough by body shape, but its public name may be the contract, so the analyzer should preserve that reason separately from ordinary boundary evidence.

## Corpus Check

Raw files:

- Before schema split: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/passthrough-candidates-200-current.json`
- After schema split: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/passthrough-candidates-200-after-public-facade-field.json`

| Corpus run | Rows | Signal | Direct | Public facade rows | Public-surface boundary rows |
| ---------- | ---: | -----: | -----: | -----------------: | ---------------------------: |
| Before     |   91 |     74 |     17 |                  0 |                            2 |
| After      |   91 |     74 |     17 |                  0 |                            2 |

Vega did not contain package/root exported facade rows in the 200-row sample, but it did confirm that the score shape stayed stable and that public-surface wording can appear as runtime boundary evidence. The local fixture supplies the positive exported-facade case.

## Implementation

- `PassthroughCandidate` now emits `publicFacadeEvidence: string[]` in addition to `boundaryEvidence`.
- `passthroughCandidateForSymbol()` computes runtime-boundary evidence and public-facade evidence separately, while preserving `actionTier: "signal"` when either list is non-empty.
- Public-facade recommendations now cite `public-facade evidence`; public-surface terms found in runtime-boundary evidence still cite `public-surface evidence`.
- Text CLI output now prints `Public facade evidence:` when that field is populated.
- The existing passthrough output fixture now asserts that exported package-surface passthrough rows populate `publicFacadeEvidence`, keep `boundaryEvidence` empty when no runtime-boundary evidence exists, remain signal-tier, and keep health score weighting unchanged.

## Verification

Completed:

- `npm test -- tests/queries/cleanup/passthrough-candidates-output.test.ts` passed 1 test.
- `npm run typecheck` passed.
- `npm run build` passed.
- Fresh Vega `passthrough-candidates --json --limit 200` after the field split produced 91 rows, 74 signal, 17 direct, 0 direct rows with evidence, and 0 signal rows without evidence.
- `node dist/cli.js similar publicFacadeEvidence --json` returned only low-similarity access-query scaffolding overlap with health rooted-symbol filters; accepted because the functions share DB/rooted-surface reads but answer different questions.
- `node dist/cli.js recent-duplicates --json` returned no findings or root-cause groups.
- `node dist/cli.js unused-params --json` returned `[]`.
- `node dist/cli.js wrapper-candidates --json` returned `[]`.
- `node dist/cli.js passthrough-candidates --json` returned `[]` locally.
- `node dist/cli.js health --json` reported score 100 with zero passthrough findings.
- `npm test` passed 67 files / 336 tests. The known noisy `git diff` fixture warning still printed, but the run exited cleanly.
- `node dist/cli.js reindex` passed.
- `node dist/cli.js diff-gate --json` returned only accepted warnings `SQ36D93309ABEA` and `SQ30E6CF5F9B38`.

Accepted final-gate warnings:

- `SQ36D93309ABEA`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` both use symbol leaf helpers, but one detects TypeScript compile-time assertion aliases and the other maps SCIP rows into indexed definitions.
- `SQ30E6CF5F9B38`: README cites cleanup detector files inside a declared-coupling JSON configuration example; the changed files remain the intended example targets.
