# Incomplete Migration Second-Corpus Scope Result

Date: 2026-06-22

## Verdict

The `incomplete-migration` second-corpus scope validation slice is complete. No analyzer code change is needed.

The scope hint works on a clean second corpus when the probe matches the detector's real operating conditions: a new helper in a changed file, at least one migrated reference, and an unchanged cross-file site that still contains the helper's callee pattern.

## Corpus Evidence

Raw files:

- Clean baseline: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/incomplete-migration-current-clean.json`
- Rejected same-file probe: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/incomplete-migration-live-api-fuzz-synthetic.json`
- Rejected same-file diff-gate probe: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/diff-gate-live-api-fuzz-synthetic.json`
- Accepted cross-file probe: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/incomplete-migration-edit-create-tool-synthetic.json`
- Accepted cross-file diff-gate probe: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/diff-gate-edit-create-tool-synthetic.json`
- Similarity support: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/similar-edit-create-tool-synthetic.json`

| Probe                | Changed file         | Unchanged leftover     | Finding | Scope label  |
| -------------------- | -------------------- | ---------------------- | ------- | ------------ |
| Clean Vega baseline  | none                 | none                   | no      | none         |
| Same-file diagnostic | `live-api-fuzz.ts`   | same file only         | no      | none         |
| Cross-file tool      | `edit-issue-tool.ts` | `create-issue-tool.ts` | yes     | `same-scope` |

The same-file diagnostic probe was useful counterevidence: it showed the analyzer correctly ignores candidate leftovers in changed files, because changed files are the active edit set. The accepted cross-file probe used Vega's existing assistant tool pair and produced one finding:

- Helper: `prepareEditIssueMigrationProbe()`
- Helper callees: 8
- Specific helper callees: 8
- Leftover: `executeCreateIssueTool()`
- Containment: 100% of helper callees
- Site coverage: 73% of site callees
- Scope: `same-scope`
- Reason: shared path/name tokens `api`, `assistant`, `issue`, `modules`, `tool`

Diff-gate carried the same scope hint into the review message and `why` text:

- Message included the unchanged create tool with `100% helper / 73% site, same-scope`.
- Why text included `Migration scope hints: ... same-scope (...)`.

## Judgment

The second corpus confirms the same-scope heuristic on a real cross-file assistant-tool pattern. It also confirms an important boundary: same-file leftovers are deliberately out of scope because the changed file is the active edit set.

No natural Vega candidate produced a `possible-subtype` second-corpus finding. That is acceptable because the local regression fixture already covers possible-subtype visibility, and the product behavior is conservative: possible-subtype rows are not hidden or downgraded out of review.

## Verification

Completed:

- Vega clean baseline `incomplete-migration --json` returned no changed files and no findings.
- Temporary same-file probe was removed after producing no finding.
- Temporary cross-file probe produced one `same-scope` finding and one diff-gate `incomplete-migration` finding.
- `similar prepareEditIssueMigrationProbe --json` confirmed the synthetic helper shared the intended callee cluster with the unchanged create tool.
- Temporary Vega code was reverted with `apply_patch`.
- `git status --short` and `git diff --stat` in Vega were clean after revert.
- Vega restore `reindex` completed after the temporary probes were removed.
- `npx prettier --check` passed for the incomplete-migration plan, result, ledger, protocol, output-schema result, and calibration memo docs.
- Local `node dist/cli.js reindex` passed.
- Local `node dist/cli.js diff-gate --json` returned only accepted warnings `SQ36D93309ABEA` and `SQ30E6CF5F9B38`.

Accepted local final-gate warnings:

- `SQ36D93309ABEA`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` both use symbol leaf helpers, but one detects TypeScript compile-time assertion aliases and the other maps SCIP rows into indexed definitions.
- `SQ30E6CF5F9B38`: README cites cleanup detector files inside a declared-coupling JSON configuration example; the changed files remain the intended example targets.
