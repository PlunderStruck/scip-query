# Minimal hierarchical CLI output

## Goal

Make scip-query's agent-facing output read like the source or report it
represents: hierarchical, whitespace-preserving, line-numbered where source is
shown, and limited to facts needed to answer the command's question.

Done means:

- agents use the ordinary human renderer by default rather than selecting JSON
  for readability;
- `code <symbol-or-range>` prints one resolved source range with stable
  one-based line numbers and no evidence-envelope metadata;
- callers that genuinely need structured data can request a command-owned,
  pretty JSON result without the public envelope;
- the existing versioned `--json` envelope remains available for programs that
  depend on it;
- output pagination does not wrap an already-complete one-page result and never
  changes human output into an opaque JSON string;
- numeric flags reject malformed values instead of accepting prefixes, emitting
  `null`, or printing an internal stack trace; and
- shipped agent guidance recommends JSON only where a machine/non-interactive
  contract actually requires it.

## Current flow

Every declared command is registered from a `CommandDescriptor` by
`registerCommandDescriptors()`. The registry installs the command's arguments
and options, gathers global pagination options, and runs the handler inside
`runWithCliOutputPagination()`. Evidence:
`scip-query trace registerCommandDescriptors` and
`scip-query trace runWithCliOutputPagination`.

Query handlers call `runCommandOutput()` or `printJsonEnvelope()`. Human mode
invokes the command-owned renderer. JSON mode passes the full command result
through `createCliJsonEnvelope()` and `serializeCliJsonEnvelope()`, adding
producer, command, schema, evidence, invocation, coverage, and optional agent
summary fields. The current uncommitted implementation additionally calculates
an observation receipt from Git status and the complete tracked diff on every
ordinary JSON call. Evidence:
`scip-query plan-context printJsonEnvelope`,
`scip-query code runCommandOutput`,
`scip-query code printJsonEnvelope`, and
`scip-query refs currentCliObservationReceipt --full`.

`code` already has the correct human presentation. `handleCode()` resolves the
target, prints its repository-relative path, range, short symbol identity, and
language, then prints each source line with a one-based line number. Its JSON
branch instead adds a symbol-resolution wrapper around a code object that
repeats the same symbol, short name, and path, and the common JSON printer then
adds the envelope. Evidence:
`scip-query code 'src/runtime/query-commands/direct-navigation.ts:225-255'`
and `scip-query code withSymbolResolutionJson`.

Output pagination captures the rendered character stream. An explicit
`--output-page-size` currently forces a `scip-query-output-page` wrapper even
when the whole result fits. JSON pages serialize that wrapper on one line and
place the original rendered JSON in the `content` string. Evidence:
`scip-query code runWithCliOutputPagination` and a live
`code createCliJsonEnvelope --json --output-page-size 30000` probe.

Command options are declared consistently, but the shared numeric parsers use
`parseInt` or `parseFloat`. A live probe established that `--context 2junk`
becomes `2`, `--context nope` succeeds with null line numbers and empty source,
and `--context -1` silently removes source lines. The stricter pagination parser
throws before the command action and therefore exposes a stack trace instead of
a recoverable CLI error.

## Surface and affected consumers

The public surface is the CLI command/output contract plus the exported runtime
decoder and TypeScript envelope types. `scip-query surface
src/runtime/cli-json-envelope.ts` found runtime command execution and
`src/runtime/index.ts` as direct indexed consumers. `scip-query change-surface
src/runtime/cli-json-envelope.ts --json --full` reported fifteen external
symbol consumers and medium risk. The ordinary JSON shape is also documented by
JSON Schema, command documentation, generated API records, fixtures, and tests;
those literal consumers were found with `rg`.

`scip-query refs printJsonEnvelope --full` returned the following complete
direct source-file set. `scip-query affected printJsonEnvelope --json` returned
a bounded twenty-symbol downstream set, all assigned below. The command does
not accept `--full`, so transitive coverage remains explicitly bounded.

| Consumer | Kind | Disposition |
| --- | --- | --- |
| `src/runtime/command-kit/command-execution.ts` (`runCommandOutput`) | direct | Extend the existing printer with an additive result-only projection; remove the uncommitted default receipt. |
| `src/runtime/commands/command-handlers.ts` (`handleReindex`, `handleDiffImpact`, `handleHealth`, `handleBench`, `handleWorkAudit`, `handleTypeScriptSemanticCompare`, `handleSetupHooks`, `renderCapabilities`, `handleConfigValidate`, `handleSuppress`, `handleEffectiveness`, `handleDoctor`, `handleSetup`, `handleUninstall`, `handleWatch`, `handleStatus`) | direct and bounded transitive | Existing envelope calls remain compatible; result-only defaults to their current command result. |
| `src/runtime/query-commands/cleanup/handlers.ts` | direct | Existing envelope calls remain compatible; descriptor options gain the shared result-only/compact surface. |
| `src/runtime/query-commands/core.ts` | direct | Existing envelope calls remain compatible. |
| `src/runtime/query-commands/direct-navigation.ts` | direct | Add the `code`-specific minimal result projection and line-number contract tests. |
| `src/runtime/query-commands/graph.ts` | direct | Existing envelope calls remain compatible. |
| `src/runtime/query-commands/health.ts` | direct | Existing envelope calls remain compatible. |
| `src/runtime/query-commands/impact.ts` | direct | Existing envelope calls remain compatible. |
| `src/runtime/query-commands/navigation.ts` | direct | Existing envelope calls remain compatible. |
| `src/runtime/query-commands/planning.ts` | direct | Existing envelope calls remain compatible. |
| `src/runtime/query-commands/tla.ts` (`runTlaScaffold`, `runTlaInstrument`, `runTlaTraceCheck`, `runTlaVerify`) | direct and bounded transitive | Existing envelope calls remain compatible. |
| `src/runtime/index.ts` | exported decoder/type consumer | Keep the schema-v1 envelope and decoder behavior unchanged. |
| `tests/runtime/cli-contract.test.ts` | test | Add shared option, result-only, strict-error, and human-first behavior assertions. |
| `tests/runtime/cli-json-envelope.test.ts` | test | Restore the published envelope baseline and prove legacy/current decoding remains compatible. |
| `tests/runtime/output-pagination.test.ts` | test | Prove complete one-page passthrough, human continuation formatting, and snapshot cleanup. |
| `docs/CLI_JSON_OUTPUT.md`, JSON schemas, command reference, README, API artifacts | doc/schema/generated | Document the three modes and regenerate mechanically owned records. |
| `skills/scip-*` and generated project guidance | agent instruction | Prefer human output; retain JSON only for machine/non-interactive needs; preserve Claude's unrelated catalog edit. |
| External shell/CI consumers of `--json` | non-indexed public consumer | Unchanged: the established envelope remains the meaning of plain `--json`. |

`scip-query co-change src/runtime/cli-json-envelope.ts --json --full` found no
hidden historical partner. `similar-files` found no sibling implementation.
The serializer similarity hits were generic `JSON.stringify` overlap, not a
reusable output contract. `doc-drift` found no broken reference in
`docs/CLI_JSON_OUTPUT.md`; its one package-history signal is not a behavior
dependency.

## Migration

This is a compatible extension:

- ordinary human output remains the default;
- plain `--json` retains the published schema-v1 envelope;
- `--json --result-only` is additive and prints only the command-owned result;
- `--compact` becomes consistently available to JSON-capable commands but is
  not recommended for agent reading; and
- the observation receipt added in the current uncommitted work is removed from
  ordinary envelopes before release. Leased Stop evidence and suppression
  adjudication retain their dedicated observation records.

Rollback is local: removing `--result-only` and restoring the old pagination
condition returns the published behavior. No stored record or database
migration is involved.

## Reuse decision

- Extend `withJsonOption()` rather than adding a second option-registration
  path. It already owns the common JSON surface.
- Extend `printJsonEnvelope()` rather than creating parallel JSON command
  handlers. It already owns every ordinary JSON result.
- Give `code` one explicit result-only projector beside `handleCode()` rather
  than teaching the generic printer about symbol-resolution object shapes.
- Extend the existing numeric parser family with exact validators rather than
  validating independently in 100 handlers.
- Reuse the current human renderers and output snapshot mechanism. The redesign
  changes mode selection and presentation, not query execution.

## Slices

### Slice 1 — Restore the lean published envelope

Remove the uncommitted ordinary-command observation field and its per-call Git
work. Retain observation receipts in the Stop lease and suppression decision
paths where state authority is the actual question.

Validation: envelope unit tests, runtime API compatibility, and a live
`code --json` probe showing the published schema-v1 keys without `observation`.

### Slice 2 — Add a minimal structured result mode

Add `--result-only` and `--compact` through the shared JSON option builder.
`--result-only` requires `--json`; it prints pretty command-owned result data
without the versioned envelope. Plain `--json` remains unchanged.

Validation: descriptor catalog assertions for every JSON-capable command,
positive result-only probes, negative option-combination tests, and unchanged
plain-envelope fixtures.

### Slice 3 — Make `code` the reference presentation

Keep the human renderer as the agent default and lock down its one-based
path/range header, indentation, blank lines, and source line numbers for both
symbol and explicit-range queries. Its result-only JSON projection contains
only the selected file, symbol, language, one-based range, and numbered source
lines; resolution alternatives appear only when ambiguity exists.

Validation: behavior tests on exact, explicit-range, missing, ambiguous, and
context-expanded targets; character-count regression comparing human,
result-only, and envelope modes.

### Slice 4 — Eliminate gratuitous page wrappers

Return the original rendered output whenever page one is already complete,
even when a page size was explicitly supplied, and remove its temporary
snapshot before returning. Preserve versioned page envelopes for genuinely
partial JSON and text headers/footers for genuinely partial human output.
Prefer the last complete newline within each human page budget so continuation
pages begin with their own hierarchy or source line number; use a character
boundary only when one rendered line itself exceeds the budget.

Validation: one-page JSON/human passthrough tests, line-aligned multi-page
reconstruction, continuation, final-page completion, long-line fallback, and
snapshot cleanup tests.

### Slice 5 — Make numeric flags exact and recoverable

Replace numeric-prefix parsing with exact finite integer/number parsing, add a
non-negative integer parser for source context and timing flags that allow
zero, and throw Commander `InvalidArgumentError` instances so malformed input
produces a concise error without a stack trace.

Validation: parser unit tests and CLI probes for suffixes, NaN-like strings,
negative context, unsafe integers, ratios, and pagination bounds.

### Slice 6 — Remove unnecessary JSON from agent guidance

Prune JSON/compact flags from model-facing command shortlists whenever the
human renderer contains the required evidence. Keep JSON only for explicitly
machine-readable or non-interactive workflows. State the moment rule once:
use normal output for agent reading; use `--json` only for a programmatic
consumer; add `--result-only` when that consumer needs only the command result.

Validation: recursive skill command validation, generated command-table drift
check, direct text audit for preemptive page sizes and unnecessary top-level
`--json --compact` recommendations.

### Slice 7 — Synchronize public documentation and generated artifacts

Update the CLI JSON contract, command reference, schemas, README examples, and
generated API records. Record that page size is measured in rendered
characters and is never selected proactively by an agent.

Validation: docs generation check, API compatibility/consumer compilation,
schema tests, and `git diff --check`.

### Slice 8 — Final verification

After the watcher refreshes the edited source, run the `scip-verify` postchecks
for runtime output, descriptor, documentation, and public API changes; then run
targeted tests, the full suite, typecheck, lint, build, API checks, skill-link
checks, live human/result-only/envelope probes, `scip-query diff-impact`, and
`scip-query diff-gate`. Fix or explicitly disposition every finding.

## Risks and unknowns

- `affected printJsonEnvelope` is bounded and has no `--full` option. Direct
  references are complete, but an unindexed/dynamic external shell consumer can
  only be protected by retaining plain `--json`, which this plan does.
- Pretty result-only JSON is for callers that need structure; it still cannot
  look as natural as source text because JSON must quote strings. Agents should
  therefore use the human `code` renderer.
- Tightening numeric syntax can reject malformed inputs that were previously
  accepted accidentally. That is intentional error detection, but release
  notes must call it out.
- Skill prose is concurrently owned history. Only output-mode recommendations
  will be changed, and the existing agent-contract catalog edit will be
  preserved byte-for-byte outside those lines.
- A genuinely partial JSON page must carry its content as a string because an
  arbitrary character boundary is not necessarily valid nested JSON. The
  redesign avoids that representation when one page suffices and keeps agents
  on human output for normal code work.

## Completion record

Implemented all eight slices on 2026-07-28.

- Default `code` output is a path/range header followed by whitespace-preserved,
  one-based numbered source. It contains no JSON transport or evidence
  metadata.
- Every public JSON-capable descriptor exposes the same trailing
  `--json`, `--result-only`, and `--compact` options. The latter two require
  `--json`; `--result-only` removes the stable transport envelope, while plain
  `--json` retains it for compatible programmatic consumers.
- `code --json --result-only` emits only file, symbol, language, one-based
  range, and ordered `{ line, text }` rows, with resolution alternatives only
  for ambiguity.
- Complete output is returned byte-for-byte even when a page size was supplied.
  Genuinely partial human output remains multiline and pages at complete line
  boundaries whenever possible; JSON paging retains the versioned resumable
  transport.
- Numeric option parsers reject suffixes, unsafe integers, invalid ranges, and
  negative source context with concise Commander errors.
- Agent skills and generated setup instructions now choose human output for
  model evidence, reserve JSON for programs, and never choose a page size
  before the command requests continuation.

Verification:

- `pnpm test`: 267 files and 2,112 tests passed.
- `pnpm lint`: formatting, ESLint, build, public API compatibility, consumer
  compilation, and skill-link validation passed.
- Public API matches manifest `0b3377c86bbfb227` across 72 paths.
- SCIP postchecks found no recent duplicate, similar page-boundary
  implementation, unused runtime parameters, or co-change partner for the
  pagination module. The semantic self-audit reported reference precision and
  recall of 1.0 for its 50-symbol sample.
- Live installed probes confirmed default hierarchical source, minimal
  result-only JSON, unchanged complete results with an explicit page size,
  strict malformed-option errors, exact continuation commands, complete
  retrieval, and line-aligned continuation pages.
- The final diff gate completed in roughly 35 seconds. Its one blocking
  co-change signal was knowingly accepted: only the cleanup descriptor's
  shared output-option declaration changed, so touching its handler would be
  false coupling; descriptor contract tests are the relevant evidence. Its two
  advisory diff-gate documentation citations were inspected and remain
  accurate.
- The verified local package was installed globally as `0.19.8`, and all nine
  shipped skills were linked into Claude, Codex, and the shared Agents root
  (27 installations total).
