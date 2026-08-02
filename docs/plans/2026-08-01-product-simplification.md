# Product simplification

## Goal

Make scip-query a compiler-backed repository map and cleanup aid. Remove its autonomous work-state and completion-management systems.

## Product boundary

scip-query supplies repository evidence. The coding agent owns the task, intent, plan, implementation, and final judgment.

The primary product questions are:

1. How is this code connected?
2. What depends on it?
3. Where is related behavior owned?
4. What structural rules constrain a change?
5. Where has the repository accumulated drift, duplication, or complexity?

## Preserve

- SCIP indexing and compiler-resolved symbol identity.
- Navigation, references, callers, dependencies, dataflow, impact, and system mapping.
- A bounded context packet for pre-edit exploration.
- Architecture configuration, architecture analysis, and architecture baselines.
- General health analysis and cleanup detectors.
- React component, hook, duplication, and pressure detectors.
- Vue component, composable, duplication, and pressure detectors.
- Finding suppressions with explicit reasons and evidence.
- Index freshness, watcher, setup, and diagnostic support.

## Simplify

- Rename the planning packet from `plan-context` to `context`.
- Describe `context` as repository evidence. Do not make it a plan owner.
- Make `health` the main cleanup report. Keep specialist detector commands available for focused follow-up.
- Keep `diff-impact` as a read-only map of changed symbols and consumers.
- Preserve useful diff detectors as nonblocking audit evidence. Do not make them a completion gate.
- Reduce installed guidance to one primary mapping skill with one pre-edit map and one final evidence review.
- Generate a short agent instruction block without goals, ledgers, completion state, or Stop cycles.

## Remove

- Goals, intended changes, attempts, decisions, obligations, plans, and completion records.
- Gherkin goal generation and structured plan contracts.
- Completion contexts, evaluations, transitions, and authority machinery.
- Protected work authorization and protected goal evidence.
- Mission-trial commands and repository-facing mission-effectiveness attachment.
- Automatic operation journaling and restoration of autonomous work state.
- Blocking diff gates and default Stop-hook enforcement.
- Setup paths that install lifecycle hooks or pre-commit gates.
- Documentation, schemas, skills, and tests that exist only for these systems.

## Compatibility

This is an intentional CLI break. Removed commands will not remain as hidden aliases.

The repository index and `.scipquery.json` architecture configuration remain compatible. Suppression records remain compatible.

Old autonomous records will be deleted from the current tree. Git history retains them.

## Implementation slices

1. Remove command registration and setup integration for work state, completion, hooks, and mission trials.
2. Remove the disconnected domain, storage, runtime, schema, test, and repository-record files.
3. Convert diff-gate aggregation into a nonblocking diff audit, or expose the useful detectors through existing audit commands.
4. Rename `plan-context` to `context` across code, tests, skills, generated documentation, and setup guidance.
5. Reduce the installed skill set and rewrite the agent setup block.
6. Update the README and command reference around mapping, architecture, and cleanup.
7. Run focused tests, type checks, formatting, lint, the full suite, and one final repository review.
8. Install the local build and run one protected matched Luna Max trial with setup outside measured work.

## Required evidence

- React and Vue health phases still run and return their framework-specific findings.
- `context` returns current flow, consumers, constraints, source slices, and coverage limits.
- Architecture analysis still reports forbidden and stale edges from explicit configuration.
- `diff-impact` still maps changed symbols to downstream consumers.
- No public CLI command, setup output, skill, or generated instruction refers to autonomous goals or completion state.
- No default agent hook or pre-commit gate is installed.
- The local package builds and the full test suite passes.
- The matched trial reports correctness, planning evidence, time, and token use for both candidates.

## Implemented result

- Removed the goal, Gherkin, work-state, completion, protected-work, mission-trial, operation-journal, Stop-hook, diff-gate, and CI/pre-commit gate systems.
- Deleted their schemas, runtime code, tests, documentation, workflow skills, and 1,023 tracked lifecycle records. Kept structured suppressions.
- Renamed `plan-context` to `context` and kept the compiler graph, impact, architecture, health, React, Vue, and focused cleanup commands.
- Reduced automatic skill installation from the old workflow family to one `scip-query` skill. The skill tells the agent to use one live-owner context map, reuse the returned source packet, and avoid a second exploration workflow.
- Made `architecture` an enforcing command. Any configured policy finding now returns a nonzero status. A stale permission under `requireMinimalPolicy` can no longer be presented as a clean architecture result.
- Added a test-only-target warning to `context`. Replacement and retirement work must anchor on the currently wired owner or a production entry point.
- Preserved strict repository architecture coverage: every indexed file and every boundary policy row is declared, with no forbidden edges or stale allowances.
- Preserved the React and Vue detector suites and their health integration.

## Protected trial results

All runs used matched isolated Luna Max candidates, the same prompt within each pair, silent final evaluation, and setup/indexing outside measured time. Each row used a new seed. The product changed between rows, so the rows diagnose successive revisions; they are not repeated samples of one fixed release.

| Run | Revision under test | Control | scip-query | Model-token delta | Time delta |
| --- | --- | ---: | ---: | ---: | ---: |
| `61992a` | Initial simplified map | 11/12 | 11/12 | +363,489 | +81.1s |
| `f3fc88` | Live-owner warning and smaller catalog | 12/12 | 10/12 | +162,183 | +57.2s |
| `3665da` | Enforced minimal architecture, four installed skills | 11/12 | 12/12 | +711,166 | +168.2s |
| `9f501c` | One installed skill and batched-map guidance | 11/12 | 11/12 | +108,378 | +61.5s |

The final revision improved planning by one scored fact and used 4,142 fewer pre-edit model tokens than control, but both candidates missed the same shared outcome-effect owner. scip-query had supplied that owner twice, including its source and the matching consumers. The remaining failure is therefore recommendation salience or agent judgment, not missing relationship evidence.

The evidence supports three bounded conclusions:

1. The live-owner context can reveal a reuse owner that ordinary reading does not reliably cause an agent to use. In run `3665da`, this changed the final result from incomplete to complete.
2. Strict architecture enforcement caught and repaired stale permissions that an earlier treatment explicitly chose to ignore.
3. Removing routed workflow skills sharply reduced overhead and made final-version pre-edit exploration slightly cheaper than control.

It does not establish that scip-query improves arbitrary autonomous coding tasks. The final fixed revision has one matched sample, its final correctness tied control, and it still used 43% more total model tokens. The next product question is how to make high-confidence existing-owner recommendations hard to overlook without recreating goals, gates, or ceremony. That needs a different task family and repeated samples, not more tuning against this fixture.
