# Rust Semantic Parity And Exclusion Ledger

Date: 2026-07-08

This ledger tracks the work to make Rust semantic analysis as reliable as the
TypeScript path, while removing brittle Rust library/framework exclusions from
cleanup health scoring. The target is not a one-shot Rust rewrite. The target is
compiler-backed accuracy, warm-run speed, and a setup path that makes the fast
path realistic for real projects.

## Evidence

- `node dist/cli.js status --capabilities` reports TypeScript semantic support
  through ts-morph and Rust semantic support through rust-analyzer.
- `node dist/cli.js plan-context src/semantic/rust/provider.ts` shows Rust now
  enters through the shared `SemanticProvider` contract, with references and
  callees backed by the Rust LSP worker.
- `node dist/cli.js plan-context src/analysis/framework-patterns.ts` shows
  `getDefinitionExclusions()` is the only producer of dead-code framework
  exclusions, including Rust generated files, test modules, trait dispatch,
  explicit suppressions, attribute macros, reflective derives, and serde
  `with` modules.
- `node dist/cli.js plan-context src/queries/cleanup/dead-exclusions.ts` shows
  `buildFileExclusionPredicate()` is the single adapter that turns exclusion
  entries into the dead-code candidate filter.
- `node dist/cli.js plan-context src/queries/cleanup/dead.ts` shows
  `deadCandidateDefinitions()` is the point where those exclusions remove
  definitions before semantic/source evidence has any chance to classify them.
- `node dist/cli.js refs src:analysis:framework-patterns:getDefinitionExclusions --json`
  shows the current blast radius is narrow: the dead-code exclusion adapter is
  the only direct consumer.

## Direction

Rust semantic support should mean "the Rust compiler's view of the program, as
exposed by rust-analyzer, normalized into scip-query facts." Rust-analyzer is a
language server: a long-running compiler intelligence process that answers
questions about a Rust project, such as "where is this symbol referenced?" or
"what does this call resolve to?" The important thing is that scip-query should
ask that process for facts and cache the answers, not guess from names whenever
compiler evidence is available.

TypeScript semantic support should remain the accuracy bar. ts-morph is a
TypeScript compiler wrapper: a library that loads the same project graph the
TypeScript compiler sees and lets scip-query ask semantic questions in-process.
A TypeScript language server can eventually become another provider, but it must
prove equal or better accuracy before replacing ts-morph. No regression trade is
acceptable just to reduce startup time.

An exclusion is currently a dead-code skip range: a source span that is hidden
from the cleanup detector because older static evidence could not see the real
caller. That is too blunt for Rust. A generated file or explicit suppression is
a hard skip. A framework-shaped attribute macro is only evidence that the symbol
may be externally invoked. Those two facts should not be represented by the same
boolean.

## Reuse Decisions

- Reuse `SemanticProvider` for Rust parity. Rust gets better by filling in
  `referencesForDefinitions`, `calleesForDefinitions`, `signatureFor`, and
  eventually `importUsage`/module facts. It should not get detector-specific
  semantic APIs.
- Reuse the existing semantic evidence product and command-scoped session
  boundary. Warm command runs should hit cache; future full-project runs should
  keep one rust-analyzer session alive instead of spawning per question.
- Reuse `getDefinitionExclusions()` as the syntax evidence producer, but change
  the payload from an untyped skip list into typed classification entries.
- Reuse `deadCandidateDefinitions()` and `deadCandidateDecision()` for candidate
  policy. The initial implementation changes which entries are hard filters;
  later slices can expose uncertain classifications in CLI output.

## Implementation Slices

### 1. Typed Rust Exclusion Dispositions

Add a disposition to `ExclusionEntry`.

- `exclude`: facts that mean "do not report this as dead code."
- `implicit-usage`: facts that mean "a macro, trait, ABI, derive, or reflection
  surface may use this even if the current graph does not show it."

The first pass keeps hard skips for generated files, explicit suppressions,
test functions/modules, `#[allow(dead_code)]`, and current TypeScript/React
exclusions. Rust framework/library-shaped attributes and reflective derives move
to `implicit-usage`, so they stop disappearing from health scoring.

Tests:

- Generated Rust headers still hard-exclude the whole file.
- Rust tests and `#[cfg(test)]` ranges still hard-exclude.
- `#[tauri::command]`, `#[wasm_bindgen]`, `#[napi]`, `#[pyo3]`, and similar
  attributes become implicit-usage evidence, not a hard dead-code skip.
- Reflective derives such as serde-like field access become implicit-usage
  evidence, not a hard dead-code skip.
- Existing TS/JS tests, React custom hooks, and explicit suppression behavior
  stay stable.

### 2. Dead-Code Output Confidence

Once entries have dispositions, add a review-facing classification to dead-code
results. A reported Rust symbol that sits under `implicit-usage` should not be
hidden, but the result should carry a reason such as "possibly macro-invoked" so
humans and agents know it needs verification.

Tests:

- A Rust function with an implicit-usage attribute appears in results with the
  implicit reason.
- A generated-file function does not appear.
- JSON output remains backward compatible for existing fields.

### 3. Rust Signatures

Implement `SemanticProvider.signatureFor()` for Rust by asking rust-analyzer for
hover/signature text at the definition location, then normalizing the result to
the same simple string contract TypeScript uses.

Tests:

- Injected resolver returns a signature through the provider.
- Worker parsing handles markup content and plaintext hover content.
- Failure keeps provider calls non-throwing and updates availability.

### 4. Rust Module And Import Facts

Add Rust module/use evidence equivalent to the TypeScript import usage path.
Start syntactic, then upgrade with rust-analyzer where it can disambiguate.

Tests:

- `use crate::module::Name` maps imported and local names.
- `pub use` re-export facts are preserved.
- Module files and inline modules resolve to stable relative paths where
  possible.

### 5. Full-Mode Semantic Coverage

Full mode should mean the query uses all available semantic facts. Heavy
operations should not disable Rust semantic analysis just to survive runtime.
Instead, they should batch, cache, and reuse a session.

Tests:

- Full dead/impact/hotspot commands keep semantic enabled for Rust when
  rust-analyzer is available.
- Warm cache runs avoid re-querying unchanged Rust definitions.
- Missing rust-analyzer degrades to source/SCIP facts with an explicit
  capability reason.

### 6. Persistent LSP Session

Replace worker-per-batch process overhead with a command-scoped Rust LSP session
that can serve references, callees, hovers, and module queries. This is the main
near-term speed path before native Rust CLI conversion.

Tests:

- One provider instance initializes one rust-analyzer session for a project.
- Multiple semantic operations reuse the same session.
- Session failures are isolated and do not poison TypeScript or source-only
  analysis.

### 7. Calibration

Use three corpora for accuracy measurement:

- scip-query itself, because it mixes TypeScript and Rust.
- VegaAssistant, because it was the requested real-world check.
- A Rust-heavy codebase such as Codex, because it stresses trait dispatch,
  modules, and generated/framework patterns.

Record counts for hard exclusions, implicit-usage classifications, semantic
references, semantic callees, signatures, runtime, and cache hit behavior.

## Current Priority

Start with typed Rust exclusion dispositions. It is the narrowest change with
the highest immediate accuracy impact: it stops library/framework names from
silently removing symbols before the semantic engine can prove whether they are
used.

## Progress

Completed in this pass:

- `ExclusionEntry` now carries a disposition. Hard exclusions still remove
  candidates; implicit-usage evidence no longer hides Rust symbols.
- Rust framework/library-shaped attributes are classified generically from the
  source attribute path instead of from a hard-coded crate/framework list.
- Rust derives are generic implicit-usage evidence because generated impls can
  touch fields regardless of which derive macro produced them.
- Attribute `with = "module"` references are generic implicit-usage evidence
  instead of serde-specific hard policy.
- Dead-code results now preserve optional `implicitUsageReason` metadata, and
  human output shows it when present.
- Rust `signatureFor()` now asks rust-analyzer hover through the shared Rust
  semantic provider path.
- Full/default health runs now pass semantic enrichment through the detector
  budget instead of inheriting stale `semantic: false` profile defaults. Bounded
  large-index health can still disable semantic enrichment explicitly.
- Rust `importUsage()` now returns Rust `use` facts through the shared semantic
  provider contract, backed by the existing Rust source parser while leaving
  room for a later rust-analyzer-specific resolver.
- Git evidence now distinguishes bounded and full history modes. Full health
  and `--full` git-history callers can remove the default 2,000-commit cap
  without changing the bounded default used by legacy helpers and stop-hook
  paths.

Remaining speed/parity gaps observed during this pass:

- Rust module/use import usage is currently source-backed. The next accuracy
  slice should add rust-analyzer-backed import/module resolution where it can
  disambiguate paths, re-exports, and macro-expanded module surfaces better
  than syntax alone.
- Rust semantic operations still spawn the batch worker per operation family.
  The main speed slice is a command-scoped persistent rust-analyzer session
  shared by references, callees, signatures, and future module facts.
