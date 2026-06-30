# Vega Locality Boundary Reasons Result

Date: 2026-06-22

## Scope

Repository:

```text
/Users/aydansalois/Documents/GitHub/Vega_2.0
```

The goal was to verify whether `locality-candidates` produces useful `suggestedHome` destinations on Vega and to tighten the withheld-destination reasons for broad but already-owned files.

A withheld destination is a locality result where consumer evidence exists, but the analyzer refuses to name an exact folder because the move would cross a source root, erase an ownership boundary, invent a missing `shared` folder, or otherwise need human design.

## Before

Command:

```sh
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json --full
```

Result:

- Total rows: 20.
- Exact `suggestedHome` rows: 0.
- All rows had `destinationConfidence: "withheld"`.

Manual judgment: this was safe, but several reasons were awkward. `apps/web/src/hooks/useAsyncLoader.ts`, `apps/web/src/lib/utils.ts`, and `apps/web/src/test-utils/render.ts` were explained as missing `apps/web/src/shared` even though `hooks`, `lib`, and `test-utils` are recognizable local ownership folders. `packages/companion/src/*` rows were explained as missing `packages/companion/src/shared` even when the file already lived at `packages/companion/src`, the nearest common owner.

## Change

Implemented in:

```text
src/queries/cleanup/locality-candidates.ts
tests/queries/cleanup/locality-candidates.test.ts
```

Behavior changes:

- Added `hooks`, `lib`, and `test-utils` to the default architectural boundary segments.
- Added an early withheld reason when `currentDirectory` already equals `nearestCommonOwner`.

## After

Commands:

```sh
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json --full
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --scope apps/web/src --json --full
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --scope packages --json --full
```

Results:

- Root Vega report: 20 rows, 0 exact `suggestedHome` rows.
- Web scope: 20 rows, 0 exact `suggestedHome` rows.
- Packages scope: 20 rows, 0 exact `suggestedHome` rows.

Improved sample reasons:

- `apps/web/src/test-utils/render.ts`: `apps/web/src/test-utils is a named architectural boundary; an exact move to apps/web/src/shared needs human design.`
- `apps/web/src/hooks/useAsyncLoader.ts`: `apps/web/src/hooks is a named architectural boundary; an exact move to apps/web/src/shared needs human design.`
- `apps/web/src/lib/utils.ts`: `apps/web/src/lib is a named architectural boundary; an exact move to apps/web/src/shared needs human design.`
- `packages/companion/src/agent-command-options.ts`: `packages/companion/src is already the nearest common owner for its consumers.`

## Judgment

This is the right direction. The analyzer remains conservative: it still emits no exact homes for Vega because the observed rows are app-wide infrastructure, local ownership boundaries, schema/config surfaces, UI primitives, or package-root helpers. The improvement is that withheld reasons now better describe why no move should be suggested.

## 2026-06-30 Consumer Evidence Product Reference Check

The cited implementation and regression test remain current after the consumer
evidence product migration:

```text
src/queries/cleanup/locality-candidates.ts
tests/queries/cleanup/locality-candidates.test.ts
```

The locality command now gets symbol-level consumer files through the shared
consumer evidence product, but the withheld-destination policy and boundary
reason behavior described above are unchanged. The locality regression test
still passes with the product-backed consumer path.
