# Command contract audit artifacts

Start with [validation-summary.json](validation-summary.json), [ledger.json](ledger.json) and the [audit report](../../../docs/plans/2026-09-06-command-audit-results.md). Each original command has a retention/removal decision, its actual claims and applicable witnesses. JSON packets under `cli/` are observations from a compiler fixture, not general proofs of accuracy.

After installing this repository's dependencies and building it, recreate the saved fixture and run the general CLI checks from the repository root:

```sh
python3 benchmarks/command-contracts/2026-09-05/make-cli-fixture.py > /tmp/scip-command-fixture-root
python3 benchmarks/command-contracts/2026-09-05/run-cli-cases.py "$(cat /tmp/scip-command-fixture-root)" /tmp/scip-command-cli-output
python3 benchmarks/command-contracts/2026-09-05/assert-cli-cases.py "$(cat /tmp/scip-command-fixture-root)" /tmp/scip-command-cli-output
python3 benchmarks/command-contracts/2026-09-05/check-retirements.py
```

`make-cli-fixture.py` creates a disposable Git repository, restores both its baseline and uncommitted changes, and indexes it using the already installed TypeScript indexer. It does not install dependencies. `run-cli-cases.py` checks expected exits and result packets; `assert-cli-cases.py` separately checks facts and arithmetic. In this fixture `entry-map main` must return `not-entry` with exit 1. Positive entry-map closures are covered by its linked unit suite.

`run-control-cases.py`, `run-transport-cases.py`, `run-frontend-cases.py` and `run-architecture-cases.py` create or use disposable projects and save their results in their corresponding directories. Run controls before frontend checks; the latter consumes the saved control-project path. `run-vue-cases.py <dependency-root>` requires an existing dependency root containing Vue language-core 3.3.11, Volar TypeScript 2.4.28 and TypeScript 5.9.3. It temporarily links those fixture dependencies and restores the original link afterward.

Full-suite evidence precedes the final shared-code relocation; `shared-boundary-unit-results.json` records the subsequent affected rerun. Neither command counts nor passing-test totals establish accuracy outside the declared contracts. The open maintainability findings in `self-review-findings.json` are not waived by these checks.
