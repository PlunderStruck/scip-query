# TypeScript exact-claim repairs

Status: complete. Historical audit results, prior uncommitted changes, and the unrelated LaunchPoint document are preserved. No commit, push or VM change is part of this request.

## Existing flow

1. Published compiler occurrences join the definition catalog in `symbols/graph/scip-chunk-occurrences.ts`. Source call facts select an invocation and its compiler declaration.
2. `scip-occurrence-call-targets.ts` and `call-graph-evidence.ts` share `invocationImplementationProof`. Its result controls exact/candidate call edges in system-map/evidence and whether resolved-call-sites can propagate arguments through a body.
3. Source binding identity delegates lexical aliases and writes to `source-binding-access.ts` and `source-binding-effects.ts`. The resolver is cached by parsed source root. Imported value context follows these identities into defining modules.
4. Static value flow evaluates literals and bounded returns using those shared bindings. Runtime extraction, including HTTP, consumes the same values and may further qualify them.
5. Full and incremental indexing share producer rules. Semantic identity, source freshness and source-root caches must remain aligned after edits.

## Comparable behavior and ownership

The previous mutation/declaration/value regressions provide real compiler/index fixtures, independently executed programs, graph-strength checks, and HTTP controls. The new audit supplies the six failing families and harmless formatting pairs. Preserve successful ordinary constants, direct calls and unrelated-property controls.

Extend shared effect tracking for Reflect receivers and direct-eval scope. Replace the bounded-return blacklist with explicit supported evaluation rules. Qualify class decoration and require precise callable ranges in the existing implementation proof. Assess alias source ranges separately from compiler reference identity; retain candidate declaration evidence when a body cannot be established.

For mutable values shared across files, use compiler-linked referents and the existing source effect owner to examine writes in referencing modules. Source gaps must return unknown, not support an absence claim. Keep this qualification in the shared imported-value path rather than adding a special rule to HTTP extraction. Primitive imported constants retain their existing evaluation path.

## Checklist

- [x] Preserve the independently executed failing audit for all six families; add 35 required regressions and controls. The focused suite reproduced all five shared-import failures before that fix.
- [x] TS-X01: qualify shared mutable values using effects in referencing modules; cover named/renamed/default/namespace/barrel imports, callbacks and deferred writers.
- [x] TS-X02: prove supported eager evaluations and parameter binding safe before publishing a constant return; qualify unsupported binding, iteration, conversion and reference operations.
- [x] TS-X03: account for Reflect.set receiver effects and setters, preserving unrelated-property controls.
- [x] TS-X04: invalidate callable/value claims exposed to direct eval in the affected lexical scope.
- [x] TS-X05: refuse established constructor identity when class decoration can replace it.
- [x] TS-X06: require precise source identity/ranges for implementation proof and make alias formatting invariant.
- [x] Re-run all 686 programs, traced calls, public consumers and 18 histories. Retain unsupported relationships as explicit limitations. Strict verifier passed; report saved at `docs/benchmarks/typescript-accuracy-audit/2026-09-09-exact-claim-repairs.json` with 536 source/configuration hashes.
- [x] Complete build, type checking, lint/API checks, full tests and fresh review/diff-impact/architecture. Full run: 3,765 passed, two timing failures; targeted rerun of both affected files: 36 passed. All 3,767 cases have passing results across these runs. Review retains 23 existing findings; no thresholds or suppressions changed.

The nine missing local targets and seventeen placeholder ranges are separately recorded coverage gaps. Address the range/proof defect needed for TS-X06 without claiming complete local-symbol graph support.

## Verification in progress

The first repaired 686-program run has zero wrong literals, wrong established bodies, inadequate established body ranges or false parameter pairs. All 18 histories agree with clean indexing after normalizing disposable checkout paths; 16 exercised incremental updates. The broader suite caught excess uncertainty when a consumer receives an imported primitive property. Fixed this by distinguishing writes to a slot from effects on the value read from it; 89 call/value regressions now pass. Repeat the audit and public consumers after the final build. Full type checking passes.

Shared-member qualification covers compiler-linked references inside the indexed project. It does not establish whole-program heap immutability against unindexed plugins, reflection or arbitrary dynamic loading. Unsupported bounded return operations and replaced/decorated/unproved implementations remain unknown or candidate evidence; no replacement execution is synthesized.

## Additional issues found during repair verification

- [x] Installed setters: `Reflect.set` with a separate receiver cannot use the target's declared property type as proof of its current descriptor. Accessor installation through `Object.defineProperty`/`defineProperties` must qualify other affected fields. Added three independently executed cases; existing sibling-property controls pass.
- [x] New shared writers: an unchanged HTTP consumer could reuse its cached constant after a new file began writing that property. Record the consulted compiler reference-file sets as well as consulted file bytes; revalidate both in direct-product and incremental retention paths. The new add/remove-writer regression checks recomputed and persisted graphs. Increment the runtime extractor version to v29 to invalidate pre-repair caches.
- [x] Namespace bracket writers: compiler occurrences already identify `owner["box"]`, but the source mapping omitted literal access nodes and the file-wide effect check excluded a write when examining that write's own occurrence. Preserve literal access ownership, include every effect for cross-file qualification, and withhold constants for unmapped references. The add/remove-writer test covers ordinary and Unicode-escaped bracket keys as well as named imports.
- [x] Build output race: the build log emitted `dist/cli.js` before another parallel configuration cleaned `dist`, deleting that output. The initial full suite consequently had 12 missing-CLI failures (3,751 other tests passed). Clean once before any build configuration starts, then rerun the complete suite against an untouched completed build.

Do not run the watcher-backed history audit concurrently with the full suite's process-lifecycle tests. One concurrent run completed graph comparisons but lost its disposable compiler service after three incremental steps; the strict verifier correctly rejected that run. Repeat it separately and require all 16 incremental transitions.

Final isolated history audit passed all 18 comparisons and exercised 16 incremental updates; the combined 686-program strict verifier also passed on the frozen final source. The multi-update regression now has an explicit 30-second test budget after the full suite exceeded Vitest's default five seconds. The separate watcher-cleanup timeout in `typescript-super-parity.test.ts` passed on retry; no graph mismatch was reported by either timing failure. Final report: `docs/benchmarks/2026-09-09-typescript-exact-claim-repairs.md`.
