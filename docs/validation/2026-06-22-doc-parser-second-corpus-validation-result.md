# Doc Parser Second-Corpus Validation Result

Date: 2026-06-22

## Verdict

The doc-reference/doc-drift parser second-corpus validation slice is complete. No analyzer code change is needed.

The Markdown-local parser works on Vega's larger documentation corpus: it extracts list items, table blocks, single-line file labels, paragraph blocks, and fenced code examples without mixing unrelated neighboring prose into the cited claim.

## Corpus Evidence

Raw files:

- Full doc-drift: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/doc-drift-current.json`
- Full doc-drift context summary: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/doc-drift-current-citation-context-summary.json`
- Targeted assistant-system doc-drift: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/doc-drift-vega-assistant-system-reference.json`
- Targeted assistant-system context summary: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/doc-drift-vega-assistant-system-reference-citation-context-summary.json`
- Diff-gate doc-reference summary: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/diff-gate-edit-create-tool-synthetic-doc-reference-summary.json`

Full Vega `doc-drift --limit 80` extracted 698 citation contexts:

| Context shape   | Count |
| --------------- | ----: |
| List item       |   459 |
| Table block     |    91 |
| Single line     |   102 |
| Paragraph block |    20 |
| Fenced code     |    26 |

The targeted `docs/vega-assistant-system-reference.md` run extracted 5 citation contexts:

| Context shape | Count |
| ------------- | ----: |
| Single line   |     2 |
| Table block   |     3 |

The saved Vega diff-gate run produced 3 `doc-reference` findings:

| Citation kind      | Action tier | Claim shape |
| ------------------ | ----------- | ----------- |
| `behavioral-claim` | `direct`    | list item   |
| `guide-reference`  | `signal`    | table block |
| `behavioral-claim` | `direct`    | table block |

## Judgment

The second corpus exercises every parser branch that the first-corpus fix intended to cover. The extracted claims are structurally local:

- List citations stay on the cited bullet rather than absorbing the surrounding section.
- Table citations return the whole table block, preserving the row's meaning without drifting into adjacent prose.
- Fenced examples return the full code/config block.
- Paragraph and single-line file labels stay bounded by Markdown separators.
- diff-gate `doc-reference` uses the same local extraction and still separates behavioral claims from guide references.

No precision patch is justified. The remaining doc-parser risk is ordinary Markdown variety, not an observed analyzer defect.

## Verification

Completed:

- `doc-drift --json --limit 80` on Vega produced 80 findings and 698 citation contexts across list, table, single-line, paragraph, and fenced-code shapes.
- `doc-drift docs/vega-assistant-system-reference.md --json --limit 80` produced one finding and 5 citation contexts across single-line and table shapes.
- The saved Vega diff-gate doc-reference output produced 3 doc-reference findings with list/table cited claims and correct action-tier split.
- `npx prettier --check` passed for the doc parser plan, result, ledger, protocol, output-schema result, and calibration memo docs.
- Local `node dist/cli.js reindex` passed.
- Local `node dist/cli.js diff-gate --json` returned only accepted warnings `SQ36D93309ABEA` and `SQ30E6CF5F9B38`.

Accepted local final-gate warnings:

- `SQ36D93309ABEA`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` both use symbol leaf helpers, but one detects TypeScript compile-time assertion aliases and the other maps SCIP rows into indexed definitions.
- `SQ30E6CF5F9B38`: README cites cleanup detector files inside a declared-coupling JSON configuration example; the changed files remain the intended example targets.
