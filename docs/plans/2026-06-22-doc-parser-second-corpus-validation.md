# Doc Parser Second-Corpus Validation

Date: 2026-06-22

## Goal

Validate the Markdown-local citation parser on a second corpus with real docs. Done means the remaining doc precision caveat is either patched or closed with evidence from `doc-drift` and diff-gate `doc-reference`.

A Markdown-local citation parser is the part of the analyzer that turns a source-file path mentioned in documentation into the smallest surrounding author-written unit that gives the citation meaning. In Markdown, those units are usually paragraphs, list items, tables, or fenced code blocks. The key precision fact is that the analyzer should classify the cited claim, not unrelated nearby prose.

## Current State

- `doc-drift` imports `markdownCitationContext()` and uses it for path-reference citation contexts. Source: `node dist/cli.js plan-context doc-drift`.
- diff-gate `doc-reference` uses the same helper in `docCitationContexts()`. Source: `node dist/cli.js code docCitationContexts -C 8`.
- `markdownCitationContext()` chooses fenced code, table, list item, or paragraph ranges before falling back to a single line. Source: `node dist/cli.js trace markdownCitationContext`.
- The first-corpus parser fix is recorded in `docs/validation/2026-06-22-doc-reference-citation-parser-result.md`.

## Reuse Audit

- Reuse the existing `doc-drift` command for full-corpus reference extraction.
- Reuse the saved Vega synthetic diff-gate output from the incomplete-migration slice to validate `doc-reference`; it changed a doc-cited file and produced real doc-reference findings.
- No new parser code is planned unless the second-corpus contexts show mixed or contaminated cited claims.

## Validation Design

### 1. Run Full Vega Doc-Drift

- [x] **Corpus**: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- **Source**: `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js doc-drift --json --limit 80`.
- **What**: Capture real path-reference citation contexts across the full Vega docs set.
- **Raw output**: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/doc-drift-current.json`.

### 2. Run Targeted Vega Doc-Drift

- [x] **Doc**: `docs/vega-assistant-system-reference.md`
- **Source**: `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js doc-drift docs/vega-assistant-system-reference.md --json --limit 80`.
- **What**: Capture table-heavy assistant-system references where local table extraction matters.
- **Raw output**: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/doc-drift-vega-assistant-system-reference.json`.

### 3. Classify Extracted Context Shapes

- [x] **Raw summaries**:
  - `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/doc-drift-current-citation-context-summary.json`
  - `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/doc-drift-vega-assistant-system-reference-citation-context-summary.json`
- **What**: Count extracted Markdown shapes and inspect representative samples.
- **Pass condition**: Lists stay list-local, tables stay table-local, fenced examples stay fenced, paragraphs stay bounded, and single-line file labels do not absorb neighbors.

### 4. Validate Diff-Gate Doc-Reference Path

- [x] **Raw summary**: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/diff-gate-edit-create-tool-synthetic-doc-reference-summary.json`
- **Source**: Saved Vega diff-gate output from the assistant-tool synthetic diff.
- **What**: Confirm `doc-reference` cited claims use the same Markdown-local extraction in review findings.

### 5. Record Verdict

- [x] **Files**: validation result, protocol, output-schema result, ledger, calibration memo.
- **Change**: Close the doc parser second-corpus caveat if no code patch is needed.

## Verification Plan

- Format touched docs.
- Run local `node dist/cli.js reindex`.
- Run local `node dist/cli.js diff-gate --json`.
- Accept only the already-reviewed final-gate warnings if they remain.
