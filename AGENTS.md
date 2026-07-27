<!-- scip-query:agent-setup:begin -->
## scip-query

This repo is indexed by scip-query (compiler-resolved code intelligence).

- Use native search and file reads for literal text and source. Use scip-query when a claim depends on compiler-resolved identity, references, callers, dependencies, consumers, public surface, transitive impact, architecture, historical co-change, or a scip detector/gate.
- Unsure how to explore, plan, verify, or clean up here: invoke the `scip-query` skill — it routes to the right specialist skill.
- Each specialist skill carries its own command shortlist — prefer it over the full `_shared` catalog.
- Before the first SCIP graph claim in a work session, run `scip-query status --capabilities` once. Reuse that fresh generation until source changes. After edits, let an active watcher finish its refresh; if it is busy or a refresh request is pending, wait and recheck instead of starting a competing reindex. Run `scip-query reindex` only when freshness is stale, missing, or unknown and the watcher is disabled, unavailable, or failed to refresh.
- For a non-trivial change: establish the current entry-to-effect flow, the affected consumers, and the reuse options before editing (`scip-plan` skill, anchored by `scip-query plan-context <target>`).
- Before claiming a complete relationship set, inspect the command coverage. If it is bounded or unknown, use `--full`, a narrower scope, or follow pagination emitted by the command before making the claim.
- After the change, run the postchecks matching what you actually edited — the table is in the `scip-verify` skill — then `scip-query diff-gate`. Fix findings or state why each is accepted.
- Run scip-query commands normally, without choosing `--output-page-size` in advance. If and only if scip-query emits `Continue exactly:`, run each emitted command unchanged until the page reports `complete: true`; incomplete output is not evidence. Never pipe scip-query through `head`, `tail`, or line-range `sed`. The emitted transport cursor is separate from a command result cursor such as `refs --cursor`.
- Repository records: commit `.scipquery/suppressions/*.json` and `.scipquery/events/*.json` with the code or docs change that produced them; do not ignore or drop these shared records.
- Checkout preferences: `.codex/hooks.json` and `.claude/settings.local.json` are local agent-tool settings and must not be committed.
<!-- scip-query:agent-setup:end -->

## Git workflow

- Work directly on `main` unless the user explicitly asks for a separate branch.
