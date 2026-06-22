# Public Command Surface Coverage

Date: 2026-06-21

## Goal

Verify that every public query command exposed by the CLI is represented in the analyzer inventory, validation protocol, and ledger. Done means the docs distinguish analyzers from support/action commands and no command in `queryCommandOrder` is silently missing from the validation program.

## Current State

- `scip-query plan-context queryCommandOrder --full` reports `src/runtime/commands/query-command-specs.ts:10` as the canonical public command order and shows `queryCommandDescriptor()` as the descriptor lookup consumed by command registration.
- `scip-query code src/runtime/commands/query-command-specs.ts:10-83` lists 61 public query commands.
- `scip-query code queryCommandDescriptor -C 8` shows a runtime guard that throws if any descriptor id is not ordered.
- A mechanical coverage check found:
  - `docs/analyzer-validation-protocol.md`: 0 missing commands.
  - `docs/analyzer-inventory.md`: missing `unused-imports` and `cleanup-apply`.
  - `docs/analyzer-validation-ledger.md`: grouped prose existed, but 20 command names were not explicitly listed.

## Reuse Audit

No new code or analyzer is needed. The existing registry guard already prevents command descriptors from being omitted from `queryCommandOrder`. This slice only reconciles documentation with that registry.

## Design

### 1. Patch Inventory Omissions

- [x] **File**: `docs/analyzer-inventory.md`
- **Source**: `scip-query code src/runtime/commands/query-command-specs.ts:10-83`
- **What**: Inventory names most cleanup and support commands but omits `unused-imports` and `cleanup-apply`.
- **Change**: Add `unused-imports` as a direct cleanup analyzer and explicitly classify `cleanup-apply` as an action command, not an analyzer.
- **Why**: Users should not infer that an exposed command is outside the validation taxonomy.

### 2. Add Ledger Command Checklist

- [x] **File**: `docs/analyzer-validation-ledger.md`
- **Source**: `scip-query code src/runtime/commands/query-command-specs.ts:10-83`
- **What**: Ledger tracks coverage at family level but does not name every command.
- **Change**: Add a grouped checklist with all 61 public query commands from `queryCommandOrder`.
- **Why**: Future command additions should have a visible checklist target.

### 3. Record the Result

- [x] **File**: `docs/validation/2026-06-21-public-command-surface-coverage-result.md`
- **Source**: mechanical coverage script against `queryCommandOrder` and the three validation docs.
- **What**: Need a durable verdict for AVL-014.
- **Change**: Record command count, doc gaps, fixes, and post-patch coverage.
- **Why**: The next slice can move to implementation parity instead of rediscovering the registry shape.

## Stress Test

- This is docs-only and reversible.
- The registry remains the source of truth; the docs now explain it.
- `cleanup-apply` stays outside analyzer scoring because it performs an action from a cleanup plan rather than detecting a smell.

## Verification

- Rerun the mechanical command coverage script.
- Run standard docs-safe verification: `npm run typecheck`, `npm test`, `./dist/cli.js reindex`, `./dist/cli.js diff-gate`.
