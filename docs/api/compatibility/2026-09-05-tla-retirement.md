# TLA command retirement

The `tla` command and its implementation were removed at the user's request. Formal-model scaffolding, mapping conformance, trace instrumentation/checking and checker downloading are outside scip-query's retained code exploration and maintenance purpose. Removed invocations fail as unknown commands; there is no compatibility alias or automatic replacement.

The implementation under `src/tla`, its CLI handler, its focused tests, formal-model fixtures and active command/skill guidance were removed. The shared verified binary-download primitive remains because the Windows SCIP indexer uses it. Dated audit captures document historical behavior and are not current instructions.

Use current-source health/review, explicit relationship evidence and executable behavior/concurrency tests for retained workflows. No equivalence between those checks and a mathematical model checker is claimed.
