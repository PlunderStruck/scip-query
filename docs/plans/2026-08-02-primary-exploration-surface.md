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
- The full suite passed: 264 files and 2,080 tests.

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

## Second matched trial

The corrected treatment completed the same hidden, read-only explanation task
in about 14.3 minutes. The control reached the hidden 15-minute limit without
a valid final answer. Both candidates started from identical source, ran in
parallel, and did not see the condition label, time limit, comparison, or score
facts. Treatment setup and indexing remained outside measured time.

The treatment used 70 shell-tool turns, compared with 291 for the unfinished
control. Its command output contained about 1.02 million characters, compared
with 1.64 million for the control. The completed treatment reported 340,096
uncached input tokens, 7,719,936 cached input tokens, and 26,960 output tokens.
The control did not emit final token usage before timeout, so this pair cannot
support a direct token-savings claim.

The treatment fully stated 11 of 15 hidden facts and partially stated the four
browser-tail facts. It also made one false extra claim by grouping invalid JSON
with missing or empty input. Under the strict trial rubric, partial facts earn
no point and that false material claim costs two points, producing 9/15. The
answer was strong through persistence and realtime publication, but it omitted
exact polling, retrieval, and rendering details.

The new surface changed exploration behavior in the intended direction, but
did not yet make it minimal. Fifty shell calls contained scip-query commands;
because many calls batched commands with `&&`, those calls launched 176 actual
queries: 86 `code`, 31 `search`, 29 `outline`, 15 `inspect`, 13 `evidence`,
and 2 `files` queries.
The agent also used native reads for final confirmation instead of relying on
already returned source. The result is favorable evidence that the primary
surface can reduce repository inventory and help an agent finish, not evidence
that its present command selection or token cost is optimal.

The next product question is narrower: make a composed packet the natural way
to close a named evidence gap, so the agent does not replace file-by-file native
inventory with symbol-by-symbol `code` and `outline` inventory. That should be
tested on a different fixture before another implementation change is credited
as a general improvement.

## Evidence-packet omission audit

The current commands still create avoidable follow-up work.

- `search` returns at most 12 matching lines with six context lines on each
  side. It identifies the owning symbol, but it does not return the whole
  readable source unit. The agent often follows it with `code`.
- Each `inspect --search` selector selects at most six matches. Search and
  location slices then share limits of 18 slices and 300 source lines. A source
  unit is limited to 80 lines. The command reports omitted matches, slices, and
  lines, but it does not give a result cursor for the omitted units.
- `evidence` includes only the definition and reference sites by default.
  Reference source has two context lines on each side. Callers, callees,
  dependencies, and consumers require explicit options. Dependencies and
  consumers contain file names, not source around the dependency edge.
- `inspect --symbol` uses four context lines for references and 60 source lines
  for each related symbol. Symbol evidence does not share the 300-line packet
  budget with search and location slices. It is also not deduplicated across
  selected symbols. Thus one packet can omit needed search units and still
  print a very large repeated symbol section.
- `context` limits its source packet to 24 slices and 600 lines. It limits the
  target to 200 lines, each consumer to 12 context lines, and each reuse
  candidate to 80 lines. It reports omissions but has no continuation for the
  remaining semantic units.
- `outline` returns structure without implementation source. `code` returns one
  definition without its relationships. `inspect --symbol` can batch several
  definitions, but the benchmark agent did not discover this as its normal
  replacement for repeated `outline` and `code` calls.

The fix is not to remove every limit. The tool must keep one bounded model
packet. The packet must select complete, decision-relevant source units. It
must deduplicate all sections under one budget. Every omitted semantic unit
must have a stable continuation or an exact follow-up selector. The normal
end-to-end packet must also include source around dependency and consumer edges,
not only their file names.
