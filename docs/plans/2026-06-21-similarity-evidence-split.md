# Similarity Evidence Split Plan

Date: 2026-06-21

## Purpose

A similarity evidence class is a category assigned to the shared facts that made two symbols look similar. Its real-world referents here are shared callees or shared source tokens such as framework calls, access checks, query helpers, random-token scaffolding, and domain-specific side-effect helpers; its essential role is to tell reviewers whether the similarity points toward direct reuse, contextual review, or low-value scaffolding.

This slice keeps `similar` visible as a contextual analyzer, but stops flattening all high-scoring pairs into the same implication. The validation pass found that some similarity rows were real consolidation leads, while others only shared access/query/random-token scaffolding and needed softer wording.

## Code Anchors

- `node dist/cli.js plan-context similarAll` resolves `similarAll()` at `src/queries/cleanup/similar.ts:133-215`, `SimilarSymbolResult` at `src/queries/cleanup/similar.ts:11-28`, and downstream consumers in health, baseline, recent-duplicates, and CLI rendering.
- `node dist/cli.js code similarAll -C 14` shows the all-pairs path builds callee fingerprints, filters ubiquitous callees, applies parameter-count guardrails, and calls `comparePair()`.
- `sed -n '1,130p' src/queries/cleanup/similar.ts` shows `comparePair()` currently returns only similarity basis, shared evidence, and unique evidence.
- `sed -n '240,330p' src/runtime/query-commands/cleanup/handlers.ts` shows text output currently renders shared callees/tokens but no evidence class or recommendation.
- `docs/validation/2026-06-21-analyzer-calibration-memo.md` records the required split: framework scaffolding, access/query scaffolding, and domain-specific behavior.

## Steps

1. [x] Extend `SimilarSymbolResult` additively.
   - Add `evidenceClass`.
   - Add `actionTier: 'direct' | 'signal'`.
   - Add `evidenceClassReasons: string[]`.
   - Add `recommendation`.

2. [x] Classify shared evidence locally in `similar.ts`.
   - `domain-behavior`: shared evidence has domain-specific verbs or side-effect sequences such as create/update/upload/set/notify/validate paired with non-generic object terms.
   - `access-query-scaffolding`: shared evidence is dominated by auth/access/permission/route/query/db/request/cache helpers.
   - `framework-scaffolding`: shared evidence is dominated by framework, lifecycle, rendering, test, random/crypto/token, or generic utility scaffolding.
   - `mixed`: domain and scaffolding evidence both appear.

3. [x] Set action tier and recommendation.
   - Use `direct` only for `domain-behavior` with enough concrete shared evidence.
   - Use `signal` for framework/access/query scaffolding and mixed cases, except strong domain behavior that also shares ordinary persistence/framework scaffolding.
   - Render recommendations that say "review whether" for signal cases and reserve direct reuse wording for domain-behavior cases.

4. [x] Keep downstream contracts stable.
   - `recent-duplicates`, health, and baseline can continue using existing fields.
   - CLI text output should show evidence class, action tier, reasons, and recommendation.
   - JSON gets the new fields automatically.

5. [x] Add focused tests.
   - Add or extend a similarity fixture for a domain-behavior direct pair.
   - Add or extend a similarity fixture for access/query or token scaffolding signal pair.
   - Keep existing similarity kernel tests untouched; this is query-output classification, not math-kernel behavior.

## Verification

- `npx vitest run tests/queries/cleanup/similar*.test.ts tests/queries/frontend/frontend-recent-duplicates.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js similar --json --limit 10`
- Stable_Management `similar --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- The evidence classifier will be lexical and imperfect. It should affect action tier and wording first, not hide results.
- Health scoring should stay low-weight until a second-repo review proves the classes predict useful repairs.

## Result

Result recorded in `docs/validation/2026-06-21-similarity-evidence-split-result.md`.

Stable_Management final smoke:

- Total rows: 217
- `domain-behavior`: 43
- `mixed`: 81
- `access-query-scaffolding`: 84
- `framework-scaffolding`: 9
- `direct`: 43
- `signal`: 174

Judgment: confirmed. Similarity output now separates direct domain-behavior leads from contextual scaffolding signals.
