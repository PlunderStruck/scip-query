# Passthrough Public-Facade Caveats Result

Date: 2026-06-22

## Verdict

The passthrough package/export and public-facade caveat slice is complete.

A public facade is an exported forwarding function that belongs to a package or configured public entry surface. It is still a passthrough in body shape, but its name is part of the import contract consumers use, so the analyzer must frame it as review evidence instead of direct inline/delete work.

## Implementation

- `passthrough-candidates` no longer drops rooted callable definitions before classification.
- Exported passthroughs declared on package public-surface files gain public-facade evidence: `exported passthrough is declared on the package public surface`.
- Exported passthroughs rooted by configured or framework public entry metadata gain public-facade entry evidence.
- Public-facade rows become `actionTier: "signal"` and recommend reviewing the public API before inlining.
- Non-exported private passthrough helpers in the same public file stay direct when they have no boundary evidence.
- The validation loop found and removed a real local passthrough introduced in the previous slice: `scopeTokensFromIdentifier()` now calls `scopeTokensFromText()` directly at its two use sites.

## Validation Samples

Focused regression:

- `tests/queries/cleanup/passthrough-candidates-output.test.ts` now covers:
  - `deleteHorse()` exported from a `package.json` public surface file: `actionTier: "signal"`, public-facade evidence, public-API recommendation.
  - `forwardHorse()` in the same file but not exported: `actionTier: "direct"` with no boundary evidence.
  - Health score weighting for two direct passthroughs and two signal passthroughs in the fixture.

Repository sample:

- `node dist/cli.js passthrough-candidates --json` returned `[]` after the local `scopeTokensFromIdentifier()` passthrough was removed.
- `node dist/cli.js health --json` reported score 100, risk score 100, hygiene score 100, and zero passthrough findings.

## Verification

Completed:

- `npx vitest run tests/queries/cleanup/passthrough-candidates-output.test.ts` passed 1 test.
- `npx vitest run tests/queries/impact/incomplete-migration.test.ts` passed 22 tests. The run still prints the known noisy `git diff` usage warning from the existing fixture.
- `npx vitest run tests/queries/cleanup/passthrough-candidates-output.test.ts tests/queries/impact/incomplete-migration.test.ts` passed 23 tests.
- `npx prettier --check src/queries/cleanup/passthrough-candidates.ts src/queries/impact/incomplete-migration.ts tests/queries/cleanup/passthrough-candidates-output.test.ts docs/plans/2026-06-22-passthrough-public-facade-caveats.md` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js recent-duplicates --json` returned no findings or root-cause groups.
- `node dist/cli.js wrapper-candidates --json` returned `[]`.
- `node dist/cli.js unused-params --json` returned `[]`.
- `node dist/cli.js reindex` passed.
- `node dist/cli.js diff-gate --json` returned only accepted warnings `SQ36D93309ABEA` and `SQ30E6CF5F9B38`.

## Residual Risk

The export detector is intentionally source-line based. It catches direct `export function`, `export default function`, exported variables, and named export statements. It does not try to prove every exotic transpiler or runtime export convention. That is appropriate for a review signal because the row exposes the evidence reviewers need.

The next precision candidate is co-change issue/PR label context and second-corpus score-weight confirmation.
