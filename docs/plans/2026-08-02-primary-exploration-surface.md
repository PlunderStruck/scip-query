# Primary exploration surface

## Goal

Make scip-query the coding agent's first code-reading surface for indexed source.

The agent must see the smallest useful set of related source in one observation.
It must not repeat the same graph work with text search and full-file reads.

## Current faults

- `trace` finds compiler-resolved reference sites, but it prints no source at those sites.
- `context` reads the start of each definition. It does not center consumer source on the actual use.
- `context --full` expands analysis work, but it does not expand the source packet.
- The 12,000-character transport page causes avoidable continuation turns for normal evidence packets.
- The installed skill lists four commands. Agents open full help or use native search to find the missing routes.
- A short ambiguous symbol name silently selects one definition and reports alternatives after doing the work.
- No scip-query command searches literal source text across indexed documents.
- No one-call surface combines a definition with the source around its references.
- No automatic final check protects declared architecture rules.

## Product boundary

Source code is the behavior record. The SCIP index supplies compiler-resolved identity and relationships.

scip-query is the primary reading surface for indexed code. A native read is for an edit range or an explicit coverage gap.

The tool will provide declared evidence views. It will not expose arbitrary SQL or an unstable internal query language.

## Implementation slices

### 1. Source evidence

- Add source around each `trace` reference site.
- Keep the complete target definition when it fits the target budget.
- Center consumer excerpts on the reference line.
- Give target, consumer, and reuse source separate budgets in `context`.
- Increase the normal transport page to 32,000 characters.
- Report omitted lines and omitted sites as coverage facts.

### 2. Literal search

- Add `scip-query search <text>` for indexed source.
- Return file, line, nearby source, and the nearest owning symbol.
- Support a fixed-string default and an explicit safe regular expression mode.
- Support scope, context, and result limits.
- State when the limit omits matches.

### 3. Composed views

- Add `scip-query evidence <symbol>` as a one-call related-source view.
- Include the definition and reference-centered source by default.
- Add callers, callees, dependencies, and reverse dependencies on request.
- Deduplicate overlapping source windows.
- Reject ambiguous symbols with exact rerun targets.

This command is the supported custom query surface. Its options select evidence relationships.

### 4. Agent guidance

- Restore a small `scip-explore` skill as a question-to-command router.
- Restore a small `concrete-plan` skill for evidence-backed plans.
- Remove the old fixed exploration ritual and the old planning template ceremony.
- Require direct evidence for ownership, flow, consumers, reuse, retirement, and architecture claims.
- Install all three focused skills.

### 5. Architecture Stop hook

- Install only a Stop hook when the repository has architecture rules.
- Run the architecture check only after source changes.
- Refresh stale evidence before the check.
- Block a stop on architecture findings or a changed `.scipquery.json` policy.
- Do not run goals, health, tests, completion records, or a diff gate.
- Keep `.codex/hooks.json` and `.claude/settings.local.json` local and untracked.

## Required evidence

- One `trace` or `evidence` call shows a definition and its real use sites with source.
- One `search` call finds literal source text without native search.
- An ambiguous evidence target fails before it presents one candidate as the answer.
- A normal `context` packet needs no transport continuation for the benchmark target.
- The installed skills route common code questions without full CLI help.
- The Stop hook allows a clean architecture result and blocks a violation.
- The full repository test suite, type check, lint, configuration check, and architecture check pass.
- A fresh matched benchmark compares the new primary surface with the control.

## Implementation outcome

Implemented on 2026-08-02.

- `search` returns bounded literal or regular-expression matches with owning symbols and source context.
- `evidence` composes definition, reference, call-graph, dependency, and consumer source in one command.
- `trace` keeps its public API contract and now has a source-rich evidence form for agent output.
- `context` gives target, consumer, and reuse source separate budgets and centers consumer slices on real uses.
- Normal output pages allow 32,000 characters before transport continuation.
- `scip-explore` and `concrete-plan` are installed as small routing skills. Plans require direct repository evidence.
- Setup installs one local architecture-only Stop hook when declared architecture rules are ready.
- POSIX indexer lookup now converts package-runner-relative binary paths to absolute paths before indexing another worktree.

Verification:

- `search OWNED_COMMAND --context 1 --limit 3` returned the declaration and both uses with source.
- One exact `evidence` call returned the implementation, reference sites, callees, dependencies, and consumers without transport continuation.
- Ambiguous evidence targets refuse to select one candidate and provide exact rerun commands.
- The architecture policy mapped 414 of 414 indexed files and passed all 36 declared dependency rows.
- The architecture Stop hook returned `{}` for the clean current diff.
- Configuration validation passed.
- Lint, formatting, API compatibility, type declarations, and skill-link validation passed.
- The full suite passed: 264 files and 2,078 tests.

## First matched trial and correction

The first protected matched explanation trial found a real product failure,
not a broken sandbox or contaminated control. The control finished in about
13.5 minutes. The scip-query treatment reached the 15-minute cap without a
final answer.

The treatment used many small observations: 59 initial `search` calls, 29
`outline` calls, 8 `code` calls, and 7 `evidence` calls. Search returned broad
sets of short windows. A compiler range for an exported object also covered
only its declaration line, hiding a nested method. The agent then rebuilt the
missing context through repeated queries and native reads.

This evidence changed the composed-view design:

- `inspect` accepts repeated text, symbol, and file-line anchors in one call.
- It expands matching lines to readable syntax units and deduplicates units
  selected by several anchors.
- It bounds the whole packet by source units and total source lines.
- `code` and `context` recover a readable syntax unit when the compiler gives
  a one-line range.
- Standalone search returns fewer, deeper windows by default.
- Agent guidance tells the model to stop file-by-file inventory and batch its
  named gaps with `inspect`.
- Large-index notices no longer claim that every semantic-budgeted command
  scans 2,500 candidates; they distinguish a bounded analysis from the
  candidate cap that only some commands use.

A new matched trial is required after this correction. The detailed trial
artifacts remain in the private trial repository.
