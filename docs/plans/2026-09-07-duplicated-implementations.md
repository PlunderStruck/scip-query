# Duplicated and diverging implementations

Baseline: `33b10dfc`. User authorized investigating and fixing duplicate or diverging implementations. Preserve the unrelated untracked LaunchPoint benchmark report.

A duplicated implementation is a separately maintained implementation of the same required behavior. Similar names, tokens, or callees only locate candidates; different compatibility contracts or responsibilities can justify separate code.

## Inventory and scope

The adjacent JSON records all 81 candidate groups: 5 exact-body groups, 60 same-name groups (33 above the default similarity threshold; 27 low-similarity homonyms), and 16 shared-callee pairs. Groups overlap. The broader inventory deliberately includes archived benchmark scripts and weak candidates so retained decisions are visible. Counts differ from aggregate health because these dedicated commands have different selection defaults; no count proves the absence of other duplication.

## Existing flow and reuse decisions

The CLI emits machine responses, subprocess results, and saved output pages through separate transport lifecycles. All identify the same producer, while envelope versions, receipt checks, limits, and malformed-result errors remain protocol-owned. Their matching structural guards now share `domain/record-validation`; protocol-specific acceptance and error precedence remain in each decoder.

Printed navigation and recovery commands escape arguments in several query/runtime modules. The existing quoting contract now lives in `src/domain/shell-arguments.ts`, with the platform import facade preserved. This gives query producers a shared command-text operation without introducing dependencies on platform services. POSIX argument round trips are tested; the existing Windows encoding policy is retained, without claiming Windows end-to-end validation.

`src/domain/record-validation.ts` already owns shared structural predicates, including safe integers and timestamps. Consumers reuse matching predicates while deliberately different protocol ranges remain separate.

Directory enumeration, AST classification, definition resolution, graph traversal, and worker orchestration were reviewed against their consumers. The inventory records shared contracts and differences; similar shape alone was not sufficient reason to merge them.

## Work list

- [x] Capture uncapped dedicated detector results and record every group.
- [x] Read implementations and live consumers; record confirmed shared contracts, counterevidence, and retained differences per group.
- [x] Consolidate confirmed shared decisions through existing owners where possible; retire all migrated local copies.
- [x] Add focused regression checks where behavior could drift; exercise actual consumers, malformed inputs, and meaningful boundary cases.
- [x] Run formatting, types, lint, build, API contract, and consumer checks. Public API baseline: `b74137d6c422ca9c`, 66 paths.
- [x] Reindex and rerun duplication/complexity/architecture/impact analysis without changing detector thresholds, rules, or suppressions.
- [x] Run the complete test suite against a frozen build; review the complete diff and commit only this work.

## Validation constraints

Do not run agent benchmarks. Do not merge independently owned state or protocol lifetimes solely to reduce counts. Preserve callbacks and receiver binding, invocation ordering, error precedence, cleanup/lock scope, accepted numeric ranges, source bounds, and public declarations. Build and tests must not run concurrently when tests use `dist`. Remaining candidates must have explicit reasons or honest unresolved gaps, not blanket claims of architectural cleanliness.

## Implemented decisions and live paths

Fourteen overlapping candidate groups are consolidated or removed; the other 67 have source-based reasons for retaining separate behavior in the inventory. This is a duplication review, not proof that each retained protocol or analysis is fully correct.

The obsolete `wrapper-propagation.ts` had no execution consumer: only an internal barrel re-export and historical docs referenced it. Its name and comments resembled a live pipeline, but the scanner actually calls `propagateCompilerResolvedHttpSummaries`. The unused module, its export, and orphan literal-constant cache are removed. The packaged API manifest does not expose that export. The real path is graph collection → HTTP summaries → compiler callsite resolution/parameter transfer → shared static value evaluation → observation/link construction.

The existing evaluator classified quoted expression text as one literal and retained escape spellings rather than their values. Ten of eleven initial regression cases failed on the pre-fix runtime source, including concatenation, escaped strings, nested template holes, and false serialized-body parameter dependencies from string/comment/property text. JavaScript/TypeScript literals (including Vue script blocks) now use the existing TypeScript compiler parser in `symbols/graph/javascript-string-value`; concatenation checks the AST operator, and both parameter-role consumers share a syntax identifier collector in the existing `source/ast/ast-callables` owner. This collector identifies syntactic mentions, not complete binding/dataflow proof through nested scopes. Other languages retain their bounded literal support; no claim of a universal string evaluator is made.

Source snapshots now share file capture/identity checking while Git and filesystem admission/validation remain separate. Shared-generation hydration has one hydrate-then-lease owner. Safe byte writes share partial-write handling and fail when no progress is made; JSON export retains its error text. Imported path union lives beside the existing import index. Config, record, shell, directory and batching helpers preserve each caller's surrounding policy. Runtime graph extractor version advances from v19 to v20 to prevent reuse of older graph semantics.

The final module arrangement keeps the source boundary at its existing 67-file limit. Byte writes belong to platform I/O, and string decoding belongs beside static value evaluation. The only architecture configuration change removes the now-unused `analysis → symbols-references` permission after deleting the obsolete wrapper; no boundary, threshold, allowance, or suppression was relaxed.

## Final scan evidence

- Exact bodies: 5 → 2 groups. Retained D03 is a seven-line operator predicate in separate compiler contexts; D05 is a three-line assertion in archived benchmark records.
- Same-name candidates including homonyms: 60 → 50 groups. Shared-callee pairs: 16 → 15. Every remaining group maps to the reviewed baseline inventory; no new unassessed group was introduced. Consolidating an inner operation does not necessarily remove an outer-function similarity candidate.
- Current-source health: 568/568 eligible TS/JS files analyzed, accounted coverage, zero findings. Dependency resolution reports zero missing and zero ambiguous imports; one dynamically constructed benchmark import remains outside static resolution. Unsupported languages and excluded tests are not covered by this source complexity claim.
- Indexed architecture: 564/564 observed files mapped, 47/47 policy rows, zero forbidden edges, cycles, boundary-limit violations, stale allowances or test-boundary violations. These are observed structural facts, not a verdict on every design decision.
- Diff impact: 41 indexed changed files, 78 changed symbols, 13 affected files. It also discloses excluded tests/config/docs and the deleted module; 58 import/deletion hunks are unattributed and six are widened using syntax. The unrelated untracked LaunchPoint report appears in the working-tree inventory but is excluded from this commit. Source review and tests supplement these limits.
- Production diff: 345 lines added, 592 removed (247 fewer lines across 42 source files). Tests and the candidate audit are additional documentation/verification code.

The incremental TypeScript service was unavailable during refresh. Default reindex preserved the accepted index rather than silently loading a full compiler graph. `reindex --allow-expensive-rebuild` successfully rebuilt TypeScript and reused unchanged Rust/Python shards; all indexed results above use the fresh generation. Incremental-service availability remains an operational gap, not something this duplicate cleanup establishes as working.

## Verification completed

The final production build passed `npm run typecheck`, changed-file ESLint/Prettier, `npm run build`, the public API contract check (`b74137d6c422ca9c`, 66 paths), and the public API consumer compilation. `npm test` passed all 3,286 tests in 370 files against that frozen build (195.86 seconds). No agent benchmarks were run.

The added regressions cover real HTTP summary propagation and direct extraction, immutable versus mutable values, JavaScript escapes/concatenation/template holes, Vue script literals, malformed literal syntax, false parameter mentions, partial byte writes/stalled output, and POSIX shell argument round trips. Existing protocol, snapshot, cache, reindex, runtime graph, navigation, and CLI tests pass. A final import-order-only test edit was checked with its focused suite; no production bytes changed afterward.
