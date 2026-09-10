# Deploy efficient agent output and investigate indexing time

Status: deployment complete and verified; indexing slowdown investigated and recorded for a separate performance change.

Target: tested `main` build `0ec86d94b0d2257f51fb94663f71586a30f20761`, package version 0.25.0, installed through SSH alias `dev-agent` under `launchpoint-agent`.

The deployment replaces the canonical account-local installation and updates its six bundled skills. Only watchers observed active immediately before replacement may be restarted; revalidate their process identities first. Preserve stopped worktrees, configuration, and the unrelated untracked LaunchPoint validation document.

- [x] Confirm the account, canonical prefix and single login-profile executable.
- [x] Identify the two currently active watchers, for `t3code-66bd3d33` and `t3code-93516b5b`.
- [x] Package the tested distribution, transfer it and verify its digest and file manifest.
- [x] Stage with compatible Linux dependencies, verify native SQLite and preserve a rollback copy.
- [x] Replace the canonical installation and update/verify skill links.
- [x] Restart only the still-active selected watchers and check their final state.
- [x] Smoke-test installed help, output behavior and a real TypeScript fixture.
- [x] Record installed build identity and deployment checks.

The user also reports slow index creation, especially runtime relationship analysis. Investigate this alongside deployment, using recorded phase timings and current process/index state before initiating expensive work.

- [x] Read existing full-refresh and runtime-analysis phase timings.
- [x] Check whether builds repeat unnecessarily and whether active watchers are performing work.
- [x] Identify the expensive runtime phases and inspect their implementations.
- [x] Record the supported diagnosis and remaining profiling/accuracy checks in the [performance follow-up](2026-09-10-runtime-indexing-performance.md). No runtime-analysis changes were included in this deployment.

Prior evidence: the previous VM refresh took 904.9 seconds for 9,221 indexed documents. That total does not by itself identify which indexing phase was slow.

## Deployment evidence

- Archive SHA-256: `68c8071b5e755336c9d842c788c2551577de03d7db0ead892a197418e0166d32`.
- Canonical package: `/home/launchpoint-agent/.local/lib/node_modules/scip-query`; one login-profile executable at `/home/launchpoint-agent/.local/bin/scip-query`.
- All 458 shipped file hashes verified after replacement, including 19 skill files; all 12 Claude/Codex links resolve to the six installed workflows.
- Existing dependency and Node-engine declarations match. An independent staged copy reused the compatible Linux dependencies; native SQLite passed before replacement. Previous package retained outside PATH for rollback.
- Watchers: `3714299` → `3817650` (`t3code-66bd3d33`), `3715157` → `3817788` (`t3code-93516b5b`). Both report idle, fresh, current validated generations. Generation identities stayed unchanged; no rebuild was necessary and no other watchers started.
- Linux fixture: index creation, expected exact helper call, cyclomatic complexity 2, zero candidate callees, source health, optional bindings and concise evidence passed. Executing the TypeScript fixture returned the expected `[3, 0, 137]`. Its watcher remained disabled.
- A 20,622-byte outline was saved completely with a 1,221-byte preview and no automatic continuation. Its contents exactly match the ordinary redirected output.

Remote receipts and rollback: `/tmp/scip-query-efficient-install-20260910-SADRtv/`. The [machine receipt](../benchmarks/agent-output/2026-09-10/vm-install.json) records artifact identity and final checks. Package version remains 0.25.0; the commit and hashes identify this build. Existing agent sessions may need to reload skills to see the updated instructions.
