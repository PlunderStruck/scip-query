# Relationship and quality workflows with lower agent token cost

Status: authorized for sequential implementation, testing, commit and push of each item.

## Purpose and observed problems

Scip-query should help an agent understand code relationships, reuse established implementations, evaluate architecture, find justified maintenance work and review its changes. Ordinary search and file-reading tools should handle routine source reading. A relationship connects exact code locations through an observed or derived fact, such as a call, value transfer or dependency. A finding connects concrete code with evidence of a possible quality problem; it does not by itself authorize a refactor.

The current guidance mandates scip-query for ordinary exploration, and mandatory continuation adds model requests that repeatedly carry conversation context. Reading two short skills produced three pages, with the last page containing only a coverage footer. Human output repeats instructions, metadata, identities, legends and recovery blocks. The 6,500-byte page budget does not measure tokenizer cost. Agents gravitate toward source-reading commands while relationship selection requires many more decisions.

The user explicitly wants routine coverage footers, unnecessary metadata and unrelated symbol listings removed. Preserve material limits and uncertainty where they affect a claim; routine success footers and calibration lectures are not required. Saving a complete query result does not prove that the analysis covered every source or possible relationship.

## Existing flow and reuse

- `src/runtime/agent-setup.ts` generates project instructions; `skills/scip-query/SKILL.md` and the five workflow skills guide command choice. Update both generated and repository guidance so the prohibition on native reads cannot persist through setup. Preserve planning's existing-flow, comparable-feature and reuse requirements.
- `src/runtime/cli-main.ts` configures output controls. `src/runtime/output-pagination.ts` owns saved output and continuation transport, and `src/platform/terminal-output.ts` defines terminal size limits. Reuse the saved-result and explicit JSON-file mechanisms instead of introducing another output store. Ordinary oversized results should produce a short useful response and a file path.
- Command renderers own human findings and relationships. Locate the shared rendering owners before edits. Preserve machine evidence and public query semantics while changing the default presentation. A failed selector, stale evidence or unresolved relationship must still be visible when it changes interpretation.
- Existing CLI/transport tests, API checks, generated command documentation and skill-link checks are the integration paths. Update expectations around intended new behavior, and retain independent accuracy and recovery assertions.

## Execution order

Each numbered item must be implemented, checked, committed and pushed before starting the next. Record the commit and validation below. Work on `main`. Preserve unrelated files. The preceding accuracy repairs already match the 3,799-test build installed on the VM; checkpoint that existing work before this series so the new commits are independently reviewable.

- [x] 0. Checkpoint and push the already-tested accuracy repairs, excluding the unrelated LaunchPoint benchmark document; commit this plan.
- [x] 1. **Guide useful analysis.** Make native source search/reads the default. Teach relationships for substantial exploration/planning and scoped quality/impact checks after changes. Remove routine evidence-ledger ceremony and compulsory continuation draining. Update generated project instructions, all affected skills, references and tests coherently.
- [x] 2. **Replace automatic continuation.** Write oversized ordinary results to an immutable local result file and return a concise answer/preview plus its path. Let agents selectively read/filter the saved result using normal tools. Small results remain inline. Keep exhaustive machine/piped output and explicitly requested pagination compatible where needed. No automatic rereading, silent truncation, extra index preparation or new watcher startup during saved-result reads.
- [ ] 3. **Remove routine presentation overhead.** Remove successful coverage/calibration/recovery footers, duplicated request metadata, banners and unnecessary wrapper fields from default human output. Keep actual failures and material limitations concise and adjacent to the affected result. Preserve machine evidence. Check representative commands rather than only a rendering helper.
- [ ] 4. **Make command contents deliberate.** Audit the public human outputs for unrelated symbols, automatically expanded constants/source, repeated identity inventories and redundant views. Keep requested relationships/findings and enough exact locations to act. Make substantive extra information explicit or available in the saved result; do not hide relevant caller/callee or uncertainty facts to reduce output.
- [ ] 5. **Measure and finish integration.** Use deterministic output fixtures and available existing session evidence to measure tokens, response sizes, automatic continuation requests and instruction overhead. Separate model requests from shell calls, and cached input from uncached input. Do not claim end-to-end cost/quality improvements from character counts or run new coding-agent benchmarks. Run final suite/API/types/format/lint/skill checks and real CLI examples, document measured changes and remaining limits, then commit and push.

## Intended workflows

| Situation | Tool contribution | Ordinary source tools |
| --- | --- | --- |
| Understand a subsystem | Module inventory and selected dependencies | Locate and read relevant implementations |
| Plan a feature/refactor | Existing execution path, consumers, handoffs and reuse candidates | Verify behavior, conventions and extension points |
| Review architecture | Module dependencies, cycles and configured rules | Assess responsibilities and consequences of boundaries |
| Clean up code | Complexity, duplication, drift and justified specialist findings | Confirm the defect and suitable repair |
| Review an actual change | Changed-function quality, downstream impact and affected dependency rules | Verify the diff and behavioral tests |

Full value means fewer total steps to a well-supported change. It does not mean using every command, loading every relationship family or reading every saved result.

## Acceptance checks

- Routine lookup does not require an analysis ceremony or scip-query source read.
- Planning still establishes and documents the existing central path and reuse choices.
- An oversized ordinary response requires no `continue` call and exposes a complete, searchable saved result with a short terminal response.
- Small successful responses contain the requested answer without routine coverage/calibration footers.
- Material incomplete/unsupported/stale evidence stays visible; saved output never upgrades evidence strength.
- Native pipelines and explicit exhaustive JSON export retain their contract.
- Relationship and smell examples retain correct independent expected facts after presentation changes.
- Every completed item has a recorded validation result, commit and successful push.

## Progress and decisions

Checkpoint `5d2524eb` pushed to `origin/main`; production hashes match the 3,799-test build and VM verification. Item 1 is complete: 24 focused setup/catalog tests, TypeScript checking, targeted lint, skill links, generated documentation, build and public API check passed. Built `setup-agent` confirmed both instruction files already match; it correctly skipped architecture-hook installation because this edited checkout has a stale index. Source review reported no new blocking findings; indexed impact identified the changed runtime consumers. Pushed as `d345bb62`. VM installation is a separate action; this request authorizes commits and pushes, not an automatic restart of VM worktree watchers after every item.

Item 2 complete: oversized default human output uses the existing immutable spool with a path and a preview capped at 1,800 bytes / 24 lines. Small output, regular-file redirects, JSON exports and explicit pagination retain their contracts. Saved files expire after one hour and oldest saved previews are reclaimed at quota pressure; pending explicit cursors are protected. 87 transport/catalog tests plus 21 public CLI tests passed; types, targeted lint and change review passed with no new blocking findings. An initial CLI run exposed test-worker message starvation from synchronous children; yielding between cases fixed the harness error, and the whole file passed again. Baseline outputs for eight public commands saved for the final comparison.
