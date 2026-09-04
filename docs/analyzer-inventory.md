# Analyzer inventory

This inventory describes the current analysis product. Historical validation
records may name commands that no longer exist; use this file and the generated
[command reference](COMMAND_REFERENCE.md) for the live surface.

An analyzer is a program that derives repository facts or maintenance leads
from indexed code, source text, configuration, or version history. A direct
finding identifies a local condition that normally has a concrete repair. A
signal identifies evidence that needs inspection before a repair can be chosen.
Support analysis maps code without claiming that the mapped code is defective.

## Support analysis

- `context` gathers one target's definitions, references, callers, callees,
  dataflow, slices, affected consumers, change risk, dependencies, public
  surface, complexity, history, suppressions, and possible reuse sites.
- Navigation commands such as `code`, `refs`, `call-graph`, `dataflow`, `slice`,
  `deps`, `rdeps`, `system`, and `surface` answer narrower questions.
- `diff-impact` maps the current change to affected symbols, tests, consumers,
  and risk. It does not approve or reject the change.
- `architecture` checks declared boundaries and dependency rules.

## General cleanup analyzers

These commands report direct findings or bounded maintenance leads:

- dead code and unused inputs: `dead`, `unused-imports`, `unused-params`,
  `stale-abstractions`;
- duplication and drift: `similar`, `similar-files`, `similar-signatures`,
  `similar-chains`, `duplicate-bodies`, `recent-duplicates`, `twin-drift`;
- unnecessary indirection: `wrapper-candidates`, `passthrough-candidates`,
  `decorative-checkers`, `not-implemented`;
- extraction and locality: `extract-candidates`, `slice-cohesion`,
  `locality-candidates`, `complexity-hotspots`;
- migration and documentation: `incomplete-migration`, `doc-drift`,
  `redundant-reexports`;
- history and coordination: `co-change`, `change-surface`.

## React analyzers

- `react-component-duplicates`
- `react-hook-candidates`
- `react-large-component-pressure`

## Vue analyzers

- `vue-component-duplicates`
- `vue-composable-candidates`
- `vue-large-view-pressure`

Vue indexing and source augmentation remain first-class parts of the product.
React and Vue findings are also represented in `health`.

## Repository health

`health` combines general, React, and Vue detector families into one review
report. It is a maintenance scan, not a completion authority. Its score and
actions help choose cleanup work; they do not prove that an arbitrary coding
task is complete.

`health --write-baseline` records the current finding identities.
`health --baseline` reports findings that are new relative to that baseline.
This is an optional repository ratchet, not a required agent ceremony.

## Suppressions

Structured suppression files record reviewed findings under
`.scipquery/suppressions/`. They are loaded with project analysis, counted in
health and context, and validated by `config-validate`. Inline
`scip-query: ignore-*` comments remain visible to the suppression inventory.

## Evidence limits

Each command reports or documents its coverage as complete, bounded, sampled,
or unknown. A complete transport only means that every rendered character was
retrieved. It does not turn bounded analysis into an exhaustive repository
claim.
