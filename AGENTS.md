<!-- scip-query:agent-setup:begin -->

## scip-query

This repo is indexed by scip-query (compiler-resolved code intelligence).

- Use native search and file reads for literal text and source. Use scip-query when a claim depends on compiler-resolved identity, references, callers, dependencies, consumers, public surface, transitive impact, architecture, historical co-change, or a scip detector/gate.
- Unsure how to explore, plan, verify, or clean up here: invoke the `scip-query` skill — it routes to the right specialist skill.
- Each specialist skill carries its own command shortlist — prefer it over the full `_shared` catalog.
- Evidence commands obtain a fresh usable index internally. Run the useful query directly; do not add `status`, watcher polling, sleeps, or `reindex` as ordinary agent steps. If the command cannot establish freshness, follow its one exact blocker or route genuine setup repair to `scip-setup`.
- Do not rerun an exact read-only scip-query command against unchanged repository content and index state. Reuse its result. Rerun only when the command input, working diff, index generation, or required coverage scope changed.
- For a non-trivial change: establish the current entry-to-effect flow, the affected consumers, and the reuse options before editing (`scip-plan` skill, anchored by `scip-query plan-context <target>`).
- Recover the canonical goal and intended change from injected restoration state. If none exists and the authorized request states a clear outcome, derive one concise Gherkin goal and use the compact contract from `scip-query plan example`; `scip-query plan apply <path>` materializes goal, change, plan, and obligations in one action.
- Before claiming a complete relationship set, inspect the command coverage. If it is bounded or unknown, use `--full`, a narrower scope, or follow pagination emitted by the command before making the claim.
- After the change, use `scip-verify` once: reuse checks that already ran, map every material requirement to direct evidence, and add only a probe that can expose an uncovered failure. The default diff gate already owns its built-in detector family; do not run those detectors as a fixed pre-gate battery.
- Give the final diff gate one owner. When protected work activation says Stop is blocking, let Stop run it; otherwise run `scip-query diff-gate` once. Rerun only after a finding causes a relevant state change.
- A clean gate and complete change establish repository predicates, not that scip-query improves autonomous work. Only a protected matched mission-trial report can support that product-effectiveness claim for its exact provider, model, runtime, and fixture scope. Mission trials calibrate releases and material workflow changes; they are not a per-change ritual.
- Prefer ordinary human output for agent reading: it preserves hierarchy, whitespace, and source line numbers without the JSON transport envelope. Use `--json` only for a programmatic consumer; add `--result-only` when that consumer needs only the command result. Do not use `--compact` for model-readable evidence.
- Run scip-query commands normally, without choosing `--output-page-size` in advance. If and only if scip-query emits `Continue exactly:`, run each emitted command unchanged until the human footer reports transport completion or a JSON page reports `complete: true`; incomplete output is not evidence. Transport completion means every rendered character was retrieved, not that bounded command coverage became exhaustive. Never pipe scip-query through `head`, `tail`, or line-range `sed`. The emitted transport cursor is separate from a command result cursor such as `refs --cursor`.
- Repository records: commit `.scipquery/goals/*.json`, `.scipquery/changes/*.json`, `.scipquery/plans/*.json`, `.scipquery/attempts/*.json`, `.scipquery/decisions/*.json`, `.scipquery/obligations/*.json`, `.scipquery/obligation-transitions/*.json`, `.scipquery/completeness-admissions/*.json`, `.scipquery/transition-rules/*.json`, `.scipquery/completion-contexts/*.json`, `.scipquery/completion-evaluations/*.json`, `.scipquery/completion-transitions/*.json`, `.scipquery/suppressions/*.json`, and `.scipquery/events/*.json` with the work that produced them; do not ignore or drop these shared records.
- Checkout preferences: `.codex/hooks.json` and `.claude/settings.local.json` are local agent-tool settings and must not be committed.
<!-- scip-query:agent-setup:end -->

## Git workflow

- Work directly on `main` unless the user explicitly asks for a separate branch.
