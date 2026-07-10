<!-- scip-query:agent-setup:begin -->
## scip-query

This repo is indexed by scip-query (compiler-resolved code intelligence).

- Unsure how to explore, plan, verify, or clean up here: invoke the `scip-query` skill — it routes to the right specialist skill.
- Each specialist skill carries its own command shortlist — prefer it over the full `_shared` catalog.
- For non-trivial implementation requests: plan first (`scip-concrete-plan` skill, anchored by `scip-query plan-context <target>`), then implement.
- After the change, run the check matching what you did: extracted a helper -> `scip-query incomplete-migration`; new helper -> `scip-query recent-duplicates`; new params -> `scip-query unused-params`; new wrapper -> `scip-query wrapper-candidates`; schema/config change -> `scip-query co-change <file>`; deleted code -> `scip-query cleanup-plan --verify`.
- Before declaring the work done: `scip-query reindex && scip-query diff-gate` — fix findings or state why each is accepted.
- Repository records: commit `.scipquery/suppressions/*.json`, `.scipquery/ledger/events.jsonl`, and `.scipquery/ledger/.gitattributes` with the code or docs change that produced them; do not ignore or drop these shared records.
- Checkout preferences: `.codex/hooks.json` and `.claude/settings.local.json` are local agent-tool settings and must not be committed.
<!-- scip-query:agent-setup:end -->

## Git workflow

- Work directly on `main` unless the user explicitly asks for a separate branch.
