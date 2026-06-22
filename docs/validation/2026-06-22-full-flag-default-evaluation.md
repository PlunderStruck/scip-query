# Full-Flag Default Evaluation

Date: 2026-06-22

## Verdict

`health` should run full by default. It is the public aggregate score for the codebase, so a capped default is easy to misread as an authoritative complete score while silently omitting candidate counts on large indexes.

Other public commands that expose `--full` should stay bounded by default for now. Their usual referents are result lists, targeted exploration reports, or candidate inventories: the value of the default is quick orientation, and the value of `--full` is deliberate exhaustive inspection.

## Policy

- Aggregate score/report commands should default to complete evidence when their output is framed as a codebase-level judgment.
- Candidate-list and top-N commands should default to capped output, because their normal use is scanning, triage, and picking the next item to inspect.
- Targeted symbol/file exploration commands should stay bounded on large indexes unless a command can prove its output size and semantic enrichment cost are naturally small.
- CI ratchet commands should keep their own operational budget policy. `health --baseline` currently uses a separate bounded baseline collector, so this change does not turn every CI gate into an unbounded repository scan.

## Command Surface Reviewed

The public generated command reference currently exposes `--full` on these command groups:

- Navigation and targeted support: `refs`, `trace`, `imports`, `by-kind`, `dataflow`, `slice`, `change-surface`, `plan-context`, `complexity`.
- Cleanup and duplicate candidates: `dead`, `unused-imports`, `isolated`, `similar`, `similar-files`, `similar-chains`, `extract-candidates`, `locality-candidates`, `cleanup-plan`, `cleanup-apply`, `recent-duplicates`, `doc-drift`, `unused-params`, `drift`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `convergence`, `redundant-reexports`, `similar-signatures`.
- Frontend analyzers: `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure`, `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure`.
- Graph and impact lists: `hotspots`, `fan-in`, `fan-out`, `coupling`, `bottlenecks`, `deep-chains`, `call-graph`, `co-change`, `incomplete-migration`.
- Aggregate health: `health`.

## Judgments

`health`: change default to full. Its user-facing referents are a score, axes, pressure, findings, and actions for the whole codebase. The output condenses many analyzers into one judgment, so completeness matters more than preview speed.

Standalone analyzer commands: keep explicit `--full`. Their referents are candidate rows. A capped default is honest because the user sees a list, can rerun with `--full`, and often wants fast triage first.

Top-N graph commands: keep explicit `--full`. Commands such as `hotspots`, `fan-in`, `fan-out`, `coupling`, `bottlenecks`, and `deep-chains` are naturally ranked reports. Defaulting them to unlimited rows would make common use worse.

Targeted support commands: keep explicit `--full` for now. Commands such as `refs`, `trace`, `dataflow`, `slice`, `change-surface`, and `plan-context` can become large when a target is central. Their default should remain fast enough for planning, while serious audits can request `--full`.

Frontend maintainability commands: keep explicit `--full`. The React and Vue skills already tell agents to use `--full` during serious frontend passes, and the row counts can be large enough that defaulting to full would make casual checks noisy.

Baseline health gate: no default change. It is a ratchet over finding identities, not the visible score report. Keeping it bounded preserves predictable CI cost until there is a separate explicit baseline-budget design.

## Implementation Result

- `health(db)` and `healthPhase(db, phase)` now default to full mode; bounded behavior is still available with `{ full: false }`.
- The visible `scip-query health` command forwards full mode by default.
- `scip-query health --full` remains accepted as a compatibility flag.
- Live docs and skills now use `scip-query health` / `scip-query health --json` where they mean the aggregate health report.
