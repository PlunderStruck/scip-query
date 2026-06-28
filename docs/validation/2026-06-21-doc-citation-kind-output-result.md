# Doc Citation-Kind Output Result

Date: 2026-06-21

## Scope

This slice implements the `doc-reference` output-quality calibration action: a finding should say why a document cites changed code before telling a reviewer what to do.

Implemented changes:

- `DiffGateFinding` now includes optional `citationKind`.
- `DiffGateFinding` now includes optional `citationKindReasons`.
- `DocCitationKind` is exported as:
  - `behavioral-claim`
  - `configuration-example`
  - `guide-reference`
  - `intentional-record`
- `doc-reference` findings now get `actionTier`.
- `doc-reference` remediation now changes by citation kind.
- Plain text `diff-gate` output prints citation kind and tier.

## Regression Coverage

Updated `tests/queries/impact/incomplete-migration.test.ts`:

- A git-backed README fixture cites `src/dead.ts` inside a `.scipquery.json` `declaredCouplings` example.
- The resulting `doc-reference` finding is classified as `configuration-example`.
- The finding is `actionTier: 'support'`.
- The remediation asks the user to verify the configuration example, not update a stale behavioral claim.

## Local Smoke

Repository: `/Users/aydansalois/Documents/GitHub/scip-query`

Raw output:

- `/tmp/scip-query-doc-citation-kind-diff-gate.json`
- `/tmp/scip-query-doc-citation-kind-diff-gate.txt`

Command:

```text
node dist/cli.js diff-gate --json
node dist/cli.js diff-gate
```

Result:

- `README.md` citing `src/queries/cleanup/dead.ts` is now:
  - `citationKind: configuration-example`
  - `actionTier: support`
  - `citationKindReasons: configuration/example terms near citation: declaredcouplings, json`
- Text output prints:
  - `citation kind: configuration-example (tier: support)`

The recurring README finding is still visible, but the remediation is now:

```text
Verify the configuration example in README.md still points at the intended file; update only if the example target changed.
```

## Verification

Commands run successfully:

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts -t "configuration-example doc references"`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js diff-gate --json`
- `node dist/cli.js diff-gate`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

`recent-duplicates` and `unused-params` returned zero rows.

Final `node dist/cli.js diff-gate --json` still exits 1 with two accepted findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains visible, but is now `citationKind: configuration-example` and `actionTier: support`.

## Judgment

Confirmed. `doc-reference` now distinguishes a behavioral doc claim from a configuration example, guide reference, or intentional record. The finding remains available for review, but support-level configuration examples no longer read like stale behavioral documentation.

## Follow-Up

The later cited-claim metadata slice extends this work in `docs/validation/2026-06-22-doc-cited-claim-metadata-result.md` by adding the actual nearby doc text behind each `doc-reference` citation and path-reference `doc-drift` subject.

## 2026-06-27 Confirmation

The declared-coupling configuration example still intentionally points at `src/queries/cleanup/dead.ts`. The dead-detector performance pass changed candidate pruning internals, not the configuration-example citation target or citation-kind output contract.
