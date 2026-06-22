# Incomplete Migration Scope Hints

Date: 2026-06-22

## Goal

Incomplete-migration findings should expose whether each leftover site appears to be in the same migration scope as the files already wired into the new helper.

A migration scope is the set of source locations that plausibly belong to one extraction rollout because their paths or symbol names share domain words. Its referents are files such as `site-a.ts`, `site-b.ts`, and `site-c.ts` moving to a new helper together. The essential maintenance fact is that callee containment alone can show the same call pattern, but path/name scope tells the reviewer whether applying the helper is probably the same migration or a subtype/variant decision.

Done means leftovers carry scope hints, CLI and diff-gate output render those hints, and a regression fixture distinguishes same-scope leftovers from a possible-subtype leftover without suppressing either.

## Current State

- `node dist/cli.js plan-context src/queries/impact/incomplete-migration.ts` shows `IncompleteMigrationLeftover` is defined at lines 10-20, `IncompleteMigrationFinding` at lines 24-35, and `incompleteMigration()` at lines 87-200.
- `node dist/cli.js code 'src/queries/impact/incomplete-migration.ts:225-263' --json` shows `collectLeftoversForHelper()` currently records containment, site coverage, extra callees, and shared callees, but no migration-scope hint.
- `node dist/cli.js code runIncompleteMigrationCheck --json` shows diff-gate currently renders leftover sites with helper/site percentages and remediation that says to migrate or confirm intentional difference.
- `node dist/cli.js code 'src/runtime/query-commands/impact.ts:120-190' --json` shows CLI text currently prints helper shape, wired files, helper/site percentages, extra callees, and shared callees.
- `node dist/cli.js recent-duplicates --json` returned no findings or root-cause groups before this slice.

## Design

### 1. Add Scope Hint Metadata

- [x] **File**: `src/queries/impact/incomplete-migration.ts`
- **Source**: `node dist/cli.js code 'src/queries/impact/incomplete-migration.ts:10-35' --json`; `node dist/cli.js code 'src/queries/impact/incomplete-migration.ts:225-263' --json`.
- **Change**: Add a `migrationScope` field to `IncompleteMigrationLeftover`, with values `same-scope`, `possible-subtype`, and `unknown`.
- **Change**: Add `migrationScopeReasons` text so JSON output explains the label.
- **Rule**: Compare domain-ish tokens from the helper, migrated files, and leftover site. Shared tokens mean `same-scope`; no shared tokens mean `possible-subtype`; empty token evidence means `unknown`.

### 2. Keep The Hint Non-Filtering

- [x] **File**: `src/queries/impact/incomplete-migration.ts`
- **Source**: `node dist/cli.js code 'src/queries/impact/incomplete-migration.ts:87-200' --json`.
- **Change**: Do not suppress `possible-subtype` leftovers. Sort likely same-scope leftovers first, then unknown, then possible-subtype.
- **Why**: This is review evidence, not proof that the helper should or should not be applied.

### 3. Render Scope Hints In Human Output

- [x] **Files**: `src/runtime/query-commands/impact.ts`, `src/queries/impact/diff-gate.ts`
- **Source**: `node dist/cli.js code runIncompleteMigrationCheck --json`; `node dist/cli.js code 'src/runtime/query-commands/impact.ts:120-190' --json`.
- **Change**: Include the scope hint in CLI leftover rows and diff-gate site summaries.
- **Change**: Make diff-gate remediation distinguish likely same-scope sites from possible subtype/variant sites.

### 4. Pin The Scope Distinction In Tests

- [x] **File**: `tests/queries/impact/incomplete-migration.test.ts`
- **Source**: existing Vitest fixture style; the test file is not indexed by SCIP, so implementation evidence comes from focused Vitest output.
- **Change**: Extend the fixture with a third unchanged site that contains the helper callee pattern but has path/name tokens outside the already migrated `site-*` scope.
- **Assertions**: `site-b` and `site-c` are `same-scope`; the new unrelated file is `possible-subtype`; all remain visible.

### 5. Record The Closed Caveat

- [x] **Files**: `docs/validation/2026-06-22-incomplete-migration-scope-hints-result.md`, `docs/analyzer-validation-ledger.md`, `docs/validation/2026-06-21-analyzer-calibration-memo.md`, `docs/validation/2026-06-21-output-schema-quality-finalization-result.md`, `docs/analyzer-validation-protocol.md`
- **Source**: completed verification commands from this slice.
- **Change**: Record the verdict and remove incomplete-migration subtype/scope hints from the missing precision list.

## Verification

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts`
- `npx prettier --check src/queries/impact/incomplete-migration.ts src/queries/impact/diff-gate.ts src/runtime/query-commands/impact.ts tests/queries/impact/incomplete-migration.test.ts docs/plans/2026-06-22-incomplete-migration-scope-hints.md`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js similar migrationScopeForLeftover --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js wrapper-candidates --json`
- `node dist/cli.js passthrough-candidates --json`
- `node dist/cli.js incomplete-migration --json`
- `node dist/cli.js dead --only-dead --json`
- `node dist/cli.js health --json`
- `npm test`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`
