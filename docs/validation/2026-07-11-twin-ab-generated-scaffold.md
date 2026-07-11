# `twin-ab` Generated-Scaffold Certification

Date: 2026-07-11
Status: Certified generated-scaffold correctness for importable TypeScript callables

## Result

`twin-ab` now satisfies its stated contract: when both resolved referents are
importable named callables, it emits a Vitest scaffold whose own source resolves
both real named exports and type-checks. When a referent is private,
non-callable, unresolved, or otherwise not importable, the command refuses
instead of writing a misleading scaffold.

The distinction matters because a private function is a callable confined to
its defining module; what prevents the external generated test from using it is
the absence of an exported binding. Supporting private twins would require
module-local generation or temporary compiler instrumentation and is not part
of this command's current contract.

## Pinned Real-Repository Evidence

Each repository was indexed from a detached worktree with a unique temporary
cache. Generated tests and compiler configurations existed only in those
temporary worktrees.

| Repository        | Commit                                     | Accepted pair                                           | Signature result | Scaffold diagnostics |
| ----------------- | ------------------------------------------ | ------------------------------------------------------- | ---------------- | -------------------: |
| openwork          | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` | `htmlResponse` in server toy UI and Den OpenAPI         | incompatible     |                    0 |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` | backend/frontend `requestEmailVerification`             | incompatible     |                    0 |
| traceroot         | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` | project/workspace settings `GeneralTab` React functions | compatible       |                    0 |

The compiler oracle used a neutral strict TypeScript program containing the
generated file, a minimal Vitest declaration, and the real imported modules.
Diagnostics in unrelated transitive project sources were counted separately.
The acceptance test was zero diagnostics whose file was the generated
scaffold. This detects unresolved modules, missing named exports, syntax
errors, and incorrect generated-call typing without misclassifying unrelated
Prisma or package-state errors as scaffold defects.

## Failing Probe and Hardening

Before the fix, Openwork and Stable Management both produced invalid files:

- Openwork accepted two private route-local `proxy` functions. TypeScript
  emitted TS2459 for both generated named imports.
- Stable Management accepted private `writeAuditEntry` declarations. TypeScript
  emitted TS2459 for the generated import from `adminConfig.ts`.

The shared export check inspected a three-line declaration window and returned
true when _any_ nearby declaration began with `export`. An adjacent exported
constant or type therefore made the following private function look exported.
The check now requires the `export` declaration to name the exact resolved leaf
symbol, while still accepting explicit `export { name }` lists.

The real private pairs now refuse with the documented “not exported” reason.
The accepted real pairs replayed with zero scaffold-local diagnostics.

## Regression and Verification Evidence

- `tests/queries/cleanup/twin-ab.test.ts` now places an exported declaration
  immediately before a private callable and proves the private callable is
  refused.
- All eight `twin-ab` fixture tests pass, including compilation of a generated
  scaffold, signature mismatch reporting, null SCIP-kind fallback, and refusal
  paths.
- The shared passthrough public-facade output test passes, protecting the other
  production consumer of export classification.
- Typecheck, lint/format, and build passed before the real-repository replay.

## Verdict Boundary

This certificate covers generator correctness and refusal accuracy for named
TypeScript exports. It does not claim that two same-name functions should be
consolidated, that placeholder input cases are automatically discoverable, or
that private callables can be tested without changing their module boundary.
