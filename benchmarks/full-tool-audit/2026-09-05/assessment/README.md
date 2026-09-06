# Follow-up assessment evidence

The [individual assessment](../../../../docs/plans/2026-09-05-full-tool-audit-assessment.md) evaluates the ten original findings and qualifies six of the nineteen failed audit assertions. Production repairs remain open.

- `verification.json` records the source-hash comparison, rerun command, counts, and artifact hashes.
- `library.json` is the fresh library probe result: 7 of 18 assertions passed, 11 failed, with the same outcomes as the original run.
- `assertion-assessment.json` classifies every original assertion without altering its recorded outcome.
- `tla-release.json` is the fresh official release metadata check. No checker binary was executed.

The sibling `artifacts/` directory retains the original capture unchanged. Rerunning `assess-results.py` against that directory reassesses historical outputs; it does not test changed production code. Future repairs require fresh executions and tests using the acceptance criteria in the assessment.
