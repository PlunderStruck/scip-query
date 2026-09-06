# Follow-up accuracy sweep

Status: in progress. The user requested the complete command inventory first, followed by another audit, and asked how many commands actually work accurately. The running CLI lists 98 top-level commands; this is an inventory, not an accuracy count.

Preserve all existing work on main. Keep original audit and repair captures unchanged. Record this sweep under `benchmarks/full-tool-audit/2026-09-05/followup/`.

## Questions and evidence

- [x] Enumerate ordinary and hidden commands from the running CLI and show the user the complete list.
- [ ] Capture help/registration contracts for every command. Passing help establishes invocation discoverability only.
- [ ] Check source health/review gates with valid and deliberately bad inputs: duplicate function identities, coverage attribution, suppression evidence and module rules.
- [ ] Check metrics and static-call claims against actual compiler-indexed source, including references to functions that are never called.
- [ ] Check local slice completeness at remaining alias, aggregate, control-flow and mutation boundaries; run source behavior to establish witnessed influences.
- [ ] Check exact navigation, ambiguity, missing roots, current/stale index and output coverage contracts.
- [ ] Check setup/maintenance recovery and compare advertised capabilities with concrete command output. Retain operational limits as such.
- [ ] Run the integrity shortlists over the relevant producers, investigate their candidates, and test the audit's own checks.
- [ ] Publish an evidence matrix distinguishing demonstrated cases, reproduced errors, heuristic limits and unverified commands. Count only executed checks; do not infer accuracy from passing tests or successful exits.

Every defect needs a reproducer, observed and expected behavior, exact producer, defense attempt, consequence and proposed repair. The bounded sweep cannot establish accuracy for every language, framework or runtime path; list uncovered areas explicitly.
