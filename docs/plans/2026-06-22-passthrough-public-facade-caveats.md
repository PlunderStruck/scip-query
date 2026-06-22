# Passthrough Public-Facade Caveats Plan

Date: 2026-06-22

## Context

`passthrough-candidates` finds small functions whose body only forwards to one callee. That is direct cleanup evidence when the forwarding name is only local indirection, but it is only signal evidence when the forwarding name is part of the package or configured public surface.

A public facade is an exported forwarding name that consumers are intended to import as the stable entry point, even if the local implementation immediately calls another function. The important validation fact is that inlining or deleting the facade can break consumers outside the local SCIP index.

`node dist/cli.js plan-context passthroughCandidates --json` anchored the change in `src/queries/cleanup/passthrough-candidates.ts`. The main caller surfaces are health summaries, baseline collection, the public query index, and the cleanup command renderer.

## Checklist

- [x] Update `passthrough-candidates` so rooted literal passthroughs are included for classification instead of being silently skipped.
- [x] Add public-facade boundary evidence for exported passthroughs declared on package/public entry surfaces, while keeping non-exported private helpers direct when they have no other boundary evidence.
- [x] Keep recommendation text aligned with the action tier: public-facade rows should say to review the public API before inlining.
- [x] Add focused fixture coverage for an exported package-surface passthrough and a private passthrough in the same public file.
- [x] Run focused tests and analyzer guardrails, then record the result in the ledger/memo documents.

## Verification

- `npx vitest run tests/queries/cleanup/passthrough-candidates-output.test.ts`
- `npx prettier --check ...`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js passthrough-candidates --json`
- `node dist/cli.js health --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`
