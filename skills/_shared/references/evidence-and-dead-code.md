# Subagent evidence boundary and dead-code resolution status

## Subagent evidence boundary

When a subagent is used to gather scip-query evidence, its prompt must include these rules verbatim:
- Use scip-query for compiler-resolved identity and completeness claims.
- Native search/file reads are valid for literal source content and local logic, including an unambiguous helper visible in the same file.
- Cite the evidence source appropriate to each claim.
- State explicitly when neither source establishes a claim completely.

The trigger for requiring scip-query evidence is **resolution or completeness, not whether execution crosses a call boundary.** Asserting what `handler(x)` does without resolving what `handler` is constitutes a resolution claim and requires scip-query evidence. Reading a helper defined two lines down in the same file is not a resolution claim and does not require it.

Reject a subagent's finding if it sources a resolution or completeness claim from text search alone. Do not reject a literal-content claim merely for citing a file read as its evidence.

## Dead-code reference-counting status (as of the 2026-07-02 remediation, `docs/plans/2026-07-02-followups.md` items 1-3)

The shared reference-counting layer used by `dead`, `isolated`, `new-dead`, and `stale-abstractions` correctly resolves as consumers:
- import type-only consumers, including tsconfig paths-aliased specifiers;
- pnpm/npm/yarn workspace cross-package consumers, including unbuilt `dist/` exports-map consumers.

Vue `<script setup>` composable consumers were already correctly resolved before this remediation — verified live, no code change needed.

**One residual gap remains:** a symbol with an ambiguous leaf name (a same-named definition exists elsewhere in the project) reached only through a re-exporting barrel file in a workspace package can still be misattributed as dead. For that case, `new-dead` labels the finding `unconfirmed (cross-package ambiguous-name resolution gap)` with evidence `heuristic` and lowered confidence, instead of asserting dead — treat it as "verify manually," not fact.

Outside that one residual gap, dead-code findings in this class are normal graph-fact dead claims: confirm with `refs` when in doubt, same as any other finding.
