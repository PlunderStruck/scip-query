# Next Primeagen Smells Compression Atlas

Date: 2026-06-07
Scope: whole repository, focused on the next obvious maintainability smells after the first disgust-register cleanup pass.

This atlas records the second-order smells a senior reviewer would notice after the first simplifications landed. The goal is not to chase health scores; the goal is to remove mechanisms that require local folklore.

## Scope Map

- Package surface: `package.json`, `tsup.config.ts`, `src/index.ts`, `src/queries/index.ts`.
- Runtime command surface: `src/runtime/query-command-specs.ts`, command descriptors, command execution helpers, CLI contract tests.
- Heavy analysis modules: `src/queries/dead.ts`, `src/queries/stale-abstractions.ts`, `src/queries/internal/candidate-scan.ts`, evidence helpers under `src/symbols`, `src/source`, and `src/core`.
- Semantic provider: `src/semantic/typescript/ts-morph-provider.ts` and existing TypeScript semantic provider tests.
- Parser adapters: `src/language-parsers/*.ts`, `src/language-parsers/utils.ts`, adapter contract docs/tests.
- Test contracts: large command/evidence tests and fixture DSL helpers.
- Architecture guardrails: `scip-query: ignore-*` suppressions that now indicate an intentional boundary or a missing named mechanism.

## Role Inventory

- Public query entry publication: decides which query modules downstream users may import.
- Query command declaration: maps command IDs, help text, options, handlers, and renderers into Commander descriptors.
- Evidence analysis pipeline: loads candidates, evidence, filters, scores, sorts, and projects results.
- Semantic project provider: discovers tsconfigs, creates projects, resolves source files, extracts definitions/references/callers.
- Parser adapter: exposes language-specific import/export/re-export/source-usage facts through a common contract.
- Evidence contract test: proves a behavior against named source modes rather than preserving a one-off incident fixture.
- Architecture suppression: documents why a local shape is intentionally broad or delegated.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| QP-1 | Replace query directory scanning and wildcard package exports with an explicit public query manifest. | `tsup.config.ts` scans `src/queries`; `package.json` exports `./queries/*`; internal helpers like `query-utils` and `health-cache-control` are therefore publication-sensitive. | enforce |
| QC-1 | Split `query-command-specs.ts` by command family after preserving the descriptor-owned command contract. | File is over 1,300 lines and mixes option decoding, query invocation, and rendering. | extract |
| TS-1 | Split TypeScript semantic provider internal roles. | `ts-morph-provider.ts` handles tsconfig discovery, project creation, cache ownership, reference lookup, source-file resolution, and fallback semantics. | extract |
| LP-1 | Compress repeated parser adapter capability helpers. | `similar-files` groups language parser modules by identical dependency shape; many adapters share "AST if available, regex/source fallback otherwise." | merge |
| EV-1 | Deepen `dead` and `stale-abstractions` only after provenance ownership is sufficient. | Both modules still assemble evidence from ProjectIndex, source text, AST, storage rows, and local scoring. | defer |
| TT-1 | Continue converting incident archive tests into evidence and command contract fixtures. | `tests/command-accuracy.test.ts` and fallback tests remain large even after fixture DSL introduction. | extract |
| SG-1 | Replace repeated suppression-comment architecture with named boundaries where a repeated policy is visible. | `rg "scip-query: ignore"` still shows clusters in symbols, source, queries, runtime, and reindex. | enforce |

## Deferred Register

| ID | Blocking fact | Revisit condition |
| --- | --- | --- |
| EV-1 | `dead` and `stale-abstractions` depend on several evidence modes whose provenance model is only partially centralized. A premature split would move policy without making it more true. | After smaller evidence-result helpers expose references/callers/definition ownership with provenance and tests. |

## Compression Clusters

- Cluster A: explicit query entry manifest. Root cause: the build and package surface infer API from file layout. This is the first cluster because it reduces accidental-public coupling before moving files around.
- Cluster B: runtime command family split. Root cause: the command algebra is now centralized but still physically braided.
- Cluster C: TypeScript semantic provider roles. Root cause: one provider class/file owns discovery, lifetime, lookup, and semantic extraction.
- Cluster D: parser adapter capability helpers. Root cause: repeated language adapters share a capability/fallback lifecycle without enough common helpers.
- Cluster E: evidence-heavy detectors. Root cause: detector files still reach through several evidence layers because provenance is not yet the default result shape.
- Cluster F: test and suppression contracts. Root cause: historical bugs and intentional architecture decisions are encoded locally instead of through named fixtures and boundaries.

## Dependency Order

1. Enforce explicit query publication before moving query files.
2. Split runtime query command specs by family while descriptor contract tests still pin command behavior.
3. Split TypeScript semantic provider internal roles with focused semantic-provider tests.
4. Compress parser adapter helper repetition after provider split, because both touch language/evidence boundaries.
5. Return to `dead` and `stale-abstractions` once supporting evidence helpers are clearer.
6. Convert remaining test/suppression clusters where each implemented cluster exposes a named mechanism.

## Touch Map

- Cluster A: `tsup.config.ts`, `package.json`, `tests/cli-contract.test.ts`, this atlas.
- Cluster B: `src/runtime/query-command-specs.ts`, new runtime command-family modules, CLI contract tests.
- Cluster C: `src/semantic/typescript/ts-morph-provider.ts`, new internal semantic provider modules, `tests/typescript-semantic-provider.test.ts`.
- Cluster D: `src/language-parsers/*`, parser contract tests.
- Cluster E: `src/queries/dead.ts`, `src/queries/stale-abstractions.ts`, evidence helpers, health/debloat tests.
- Cluster F: tests and suppression documentation near touched mechanisms.

## Validation Plan

- Cluster A: package export contract test, `npm run build`, package self-import smoke for exported and intentionally non-exported query subpaths.
- Cluster B: CLI contract tests plus targeted command accuracy tests.
- Cluster C: TypeScript semantic provider tests plus typecheck.
- Cluster D: parser/fallback tests plus command accuracy tests.
- Cluster E: debloat, stale-abstractions, source-backed accuracy, health, and full test suite.
- Final audit: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run reindex` if available, `node dist/cli.js health --json`, `node dist/cli.js drift --min-deviation 3`, `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120`.
