# Hyper Optimization Discovery Skill Plan - 2026-06-28

## Goal

Update the `scip-hyper-optimization` skill so it teaches the shortest reliable
path from slow behavior to a validated optimization: target selection,
output-contract capture, cold/warm controls, hierarchical profiling,
bottleneck classification, focused fix, and output-identity verification.

Done means the skill no longer merely says "profile end to end"; it tells an
agent where to place spans first, when to descend into finer spans, what signals
identify large wins, and when to reject a faster change.

## Current State

`scip-query plan-context skills/scip-hyper-optimization/SKILL.md --json` could
not index the Markdown file as a code symbol, so the skill edit itself has no
compiler graph. The optimization lesson is grounded in
`scip-query trace semanticCalleeMap --json`, which shows the semantic callee
map as the changed hot path feeding cached callee evidence and analyzer
consumers.

The existing skill already requires a measurement harness, run history,
cold/warm scenarios, internal profiling, current-pipeline optimizations,
alternative designs, verification, and a final scoreboard. It does not yet
encode the discovery pattern that found the 300s -> 12s win: coarse spans first,
split the dominant span, attach counts to every timed span, compare profiled and
unprofiled controls, classify cold-only versus warm bottlenecks, and reject
faster changes that alter the output contract.

## Reuse Audit

No new code symbol is required. Reuse the existing
`skills/scip-hyper-optimization/SKILL.md` workflow and the existing
`skills/scip-hyper-optimization/agents/openai.yaml` metadata. The update is a
precision rewrite of the skill body, not a new skill or bundled script.

## Design

### 1. Add A Discovery Ladder

- [x] **File**: `skills/scip-hyper-optimization/SKILL.md`
- **Source**: `scip-query trace semanticCalleeMap --json`
- **What**: The current skill says to profile the timed chain but leaves the
  granularity decision mostly implicit.
- **Change**: Add a discovery ladder: rank target, map chain, measure
  cold/warm/profiled/unprofiled controls, instrument coarse spans, descend only
  into the span that dominates wall time, and add counts to every span.
- **Why**: The major win came from recursively narrowing `similar.all` ->
  callee map -> semantic provider loop -> TypeScript per-file work -> checker
  lookup.

### 2. Add Bottleneck Signatures

- [x] **File**: `skills/scip-hyper-optimization/SKILL.md`
- **Source**: `scip-query trace semanticCalleeMap --json`
- **What**: The current skill lists common inefficiencies but does not connect
  profile shapes to likely fixes.
- **Change**: Add a small diagnostic table for cold-only cache fill, warm cache
  scan, repeated singleton initialization, high-count medium-cost loops,
  wrapper-object traversal, broad database scans, subprocess startup, and
  serialization.
- **Why**: The 300s path was a repeated expensive singleton/checker lookup
  hidden inside a per-file semantic loop.

### 3. Tighten The Acceptance Gate

- [x] **File**: `skills/scip-hyper-optimization/SKILL.md`
- **Source**: `scip-query trace semanticCalleeMap --json`
- **What**: The current skill already says unchanged output is required.
- **Change**: Make profiled/unprofiled controls and output identity mandatory
  after each accepted change; explicitly reject pruning unless equivalence is
  proven by output identity and representative tests.
- **Why**: The syntactic prefilter was faster but invalid because it changed the
  result corpus and output bytes.

### 4. Refresh Skill Metadata

- [x] **File**: `skills/scip-hyper-optimization/agents/openai.yaml`
- **Source**: local skill metadata file; no code graph.
- **What**: The metadata currently describes profiling-driven optimization
  generally.
- **Change**: Mention hierarchical profiling and output-preserving cold/warm
  optimization.
- **Why**: The UI prompt should steer agents toward the sharper discovery loop.

## Verification

1. Validate the skill frontmatter and YAML metadata parse.
2. Run formatter on changed Markdown/YAML.
3. Run `node dist/cli.js diff-impact --json`.
4. Run `node dist/cli.js diff-gate --json` after reindexing if stale.

## Verification Result

- `npx prettier --write skills/scip-hyper-optimization/SKILL.md skills/scip-hyper-optimization/agents/openai.yaml docs/plans/2026-06-28-hyper-optimization-discovery-skill.md` passed.
- `python3 /Users/aydansalois/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/scip-hyper-optimization` passed.
- `ruby -e "require 'yaml'; YAML.load_file('skills/scip-hyper-optimization/agents/openai.yaml')"` passed.
- `node dist/cli.js reindex` passed using the cached TypeScript shard.
- `node dist/cli.js diff-impact --json` passed.
- `node dist/cli.js diff-gate --json` passed with zero findings; the existing interface-dispatch suppression remains the only suppressed item.
