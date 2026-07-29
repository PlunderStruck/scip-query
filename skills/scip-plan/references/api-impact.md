# Public-surface impact

Use before changing anything another process or person depends on: a callable, export, route, schema, config field, CLI command, generated artifact, or documented behavior. Its defining trait: a local edit can force coordinated consumer, docs, tests, or migration changes outside the implementation file.

## Scenario: assess what breaks before editing a public surface

**Step 1 — identify the actual surface.** Run `scip-query surface <module-or-package>`, `scip-query outline <file>`, `scip-query trace <symbol-or-command>`, `scip-query code <symbol-or-command>`, and `scip-query hierarchy <symbol>`. Done only when the real surface is named as one of: member, class, module, package, route, schema, command, or config field.

**Step 2 — find consumers.** Run `scip-query refs <symbol>`, `scip-query fan-in <symbol>`, `scip-query rdeps <file>`, `scip-query affected <symbol>`, and `scip-query change-surface <file> --full`. Record direct consumers separately from transitive consumers. Done only when direct breakage and regression blast radius are both known.

**Step 3 — find hidden partners.** Run `scip-query co-change <file> --full` (files historically coupled without a dependency edge), `scip-query doc-drift --full` (docs describing the surface), `scip-query similar <symbol> --full`, and `scip-query similar-files <file> --full`. Docs, generated files, tests, and config count as part of the API when they describe or enforce the surface. Done only when docs, generated files, fixtures, sibling APIs, and hand-synchronized partners are accounted for or ruled out.

**Step 4 — choose the migration shape.** Pick one of: compatible extension, two-step migration, breaking coordinated change, or an adapter shim for external consumers/compatibility windows. Prefer backward-compatible migrations when consumers are broad or external. Reject speculative new parameters or empty wrappers using `scip-query unused-params --full`, `scip-query wrapper-candidates --full`, and `scip-query passthrough-candidates --full`. Done only when the migration shape explains deploy order, rollback, and compatibility risk.

**Step 5 — write the plan and verify.** Plan template: Surface; a Consumer dispositions table (Consumer | Kind: direct/transitive/doc/config/test | Disposition: unchanged-safe/update/shim/defer); Required co-changes; Migration; Verification (targeted tests, `scip-query diff-impact`, `scip-verify`, `scip-query doc-drift --full` if docs changed, `scip-query config-validate` if config changed). Every consumer returned by refs/affected must appear as a row — a blank disposition means the analysis is unfinished. Non-indexed consumers (SQL, fixtures, dynamic strings, external callers) must be checked with `rg` and rowed the same way as indexed consumers.

After editing, run the routed checks from `_shared` and invoke `scip-verify`. The workflow is complete only when direct consumers, docs/config partners, and scip-verify have all been checked.

Final report shape: API impact (low/medium/high); Surface changed; Consumers; Migration plan; Co-changes; Verification; Remaining risk.
