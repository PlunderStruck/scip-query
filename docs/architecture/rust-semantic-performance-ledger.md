# Semantic Engines, Setup, and Native Speed Ledger

This ledger records the direction for making TypeScript and Rust semantic
support accurate, fast, and pleasant to install. It supersedes the earlier
Rust-only ledger without dropping the Rust rewrite ambition: native Rust should
enter scip-query where measurement proves a stable hot core is worth moving.

This is not a narrow implementation checklist. It is the architectural memory
for the next few slices.

## North Star

scip-query should be a coordinator over reliable local evidence engines.

The durable project map comes from SCIP indexes. The fast source-shape facts
come from source parsers. The deepest language facts come from compiler-grade
semantic engines such as `ts-morph`, `tsserver`, and `rust-analyzer`. Expensive
facts should become evidence products so a later command can reuse them without
re-asking the engine. CPU-heavy kernels should move to Rust only after profiling
shows the TypeScript implementation is the limiting cost.

Full mode should mean: use every available reliable evidence channel over every
eligible candidate. Bounded mode should remain a latency budget for interactive
work, not a workaround for semantic engines being too expensive.

Setup should feel like a guided local installer. A user should run
`scip-query setup`, see what scip-query detected, and choose which local project
files or tools to install. It should not surprise-create agent docs, hooks, or
language tooling.

## Working Vocabulary

A SCIP index is the durable code map produced by language indexers. Its real
referents are SQLite rows for files, symbols, definitions, references, and
ranges; it is the project graph that lets scip-query ask language-neutral
questions after indexing.

A semantic engine is a language-aware program or library that understands name
binding, types, references, calls, and signatures. Its real referents here are
`ts-morph`, `tsserver`, and `rust-analyzer`; it is the compiler-grade source of
facts that separates real code relationships from matching text.

A language server is a long-running local semantic engine that answers editor
requests. Its real referents are processes such as `rust-analyzer` and
`tsserver`; its important trait is that it keeps a project loaded in memory, so
many semantic questions can share the expensive project load.

`ts-morph` is a TypeScript compiler API wrapper that runs inside the Node
process. Its real referent is the current TypeScript semantic provider in
`src/semantic/typescript/ts-morph-provider.ts`; its important trait is that it
gives deterministic compiler-backed facts without a separate server protocol.

A persistent semantic session is a reused connection to a semantic engine for
one project. Its real referents are a warmed `rust-analyzer` process, a warmed
`tsserver` process, or an in-process `ts-morph` project bundle; its important
trait is that many semantic queries share one loaded project instead of paying
startup every time.

An evidence product is a stored analysis result with a key that names the facts
that produced it. Its real referents are rows in `evidence.db` and sidecar cache
files; its important trait is that a cached answer is reused only while source,
project, tool, and configuration identity still match.

A guided setup flow is a local project installer that asks before it changes the
project. Its real referents are choices such as installing hooks, updating
`AGENTS.md`, creating `CLAUDE.md`, installing Tree-sitter parsers, and installing
language indexers; its important trait is consent over local changes.

A native acceleration module is Rust code behind a narrow TypeScript contract.
Its real referents are future graph, SQLite, parsing, scoring, and history
kernels; its important trait is that it replaces a measured hot loop without
moving the whole product surface at once.

## Current State

- `scip-query status --capabilities` on 2026-07-08 reports this repository's
  index as fresh with TypeScript semantic support available through ts-morph.
- `src/semantic/types.ts` defines the shared `SemanticProvider` contract for
  references, caller maps, callees, import usage, and signatures.
- `src/semantic/provider-cache.ts` chooses a semantic provider by language and
  delegates command-local object reuse to `SemanticSessionManager`. TypeScript
  requests now prefer the existing project watch service's persistent ts-morph
  session and fall back to the direct provider; Rust keeps its separately
  calibrated durable-session route. The manager remains the per-database
  provider boundary rather than the cross-process owner.
- `src/semantic/typescript/ts-morph-provider.ts` is the mature TypeScript
  semantic provider. It loads ts-morph, discovers tsconfigs, constructs project
  bundles, caches import usage/references/callees/signatures, and bulk-scans
  references when the batch is large enough. Exact cross-file caller batches
  use a hierarchy-aware file-first scan keyed by compiler declaration identity;
  broader full-location requests retain precise per-definition compiler lookup.
- `src/semantic/typescript/tsserver-provider.ts` is an experimental
  TypeScript-language-service comparison provider. It exists to compare against
  ts-morph, not to replace ts-morph by default.
- `src/semantic/rust/lsp-session.ts` selects a demand-started durable
  `rust-analyzer` session by default behind the Rust provider, with an explicit
  per-command worker opt-out and automatic worker failover. It serves
  references, callees, hover-derived signatures, and compiler-backed
  import-definition lookups. Shared resolver contracts and batch-completion
  primitives live in dependency-free `semantic-resolution.ts`, preventing the
  provider, import-usage, and durable-session paths from importing each other.
- `src/semantic/rust/import-usage.ts` combines source-fallback Rust `use`
  parsing with `rust-analyzer` definition answers for project-local import
  source paths.
- `src/semantic/shared-primitives.ts` persists semantic reference cache entries
  for TypeScript and Rust, plus Rust project-scoped import usage and signature
  products. It now materializes cached references through file-level bulk reads
  so full-mode detector passes do not issue one storage read per definition.
  Targeted graph callers can also request references for a symbol batch, which
  lets breadth-first affected traversal pay the compiler/provider setup cost
  once per frontier instead of once per symbol.
  `dead --full` materializes versioned TypeScript caller fragments: file-owned
  semantic records whose hierarchy-aware facts preserve exact cross-file caller
  presence. Missing or uncertain fragment identities fall back to the precise
  per-definition compiler path; full reference-location parity is not inferred
  from the caller-specific product.
  Rust cache identity is salted with language and `rust-analyzer` engine
  metadata so TypeScript and Rust invalidation do not drift together.
- `src/semantic/symbol-evidence.ts` persists semantic callees and salts Rust
  callee cache identity with the same Rust semantic engine identity. Cached
  callees are read in file-level batches for full-mode hot paths.
  `src/symbols/graph/call-graph-evidence.ts` consumes those optional facts
  through the symbols-owned semantic-evidence port; targeted caller rows expose
  a bulk boundary while preserving each symbol's resolved-reference-first
  result order.
- `src/storage/evidence-cache.ts` accepts both complete and intentional partial
  project fingerprints. The cache key includes the index status, so complete and
  partial indexes do not share project-scoped rows accidentally. It exposes
  semantic callee/reference bulk readers that preserve the same current and
  legacy key semantics as the single-row readers. Database-backed fingerprint
  construction now uses the metadata snapshot retained by the open SQLite
  generation handle, so a concurrent publication cannot attribute old cache
  rows to a new index identity. The same file now serializes worktree-local
  finding-outcome observations under one immediate SQLite transaction: stable
  run IDs deduplicate exact retries, distinct runs add their count deltas, and
  a lock timeout skips only that best-effort metric update.
- `crates/scip-query-kernels` is a first native-kernel experiment. It proves
  SCIP symbol leaf extraction can match TypeScript fixture behavior, but the
  helper-binary benchmark is slower for 100k symbols because process and
  stdin/stdout overhead dominate.
- `src/runtime/project-readiness.ts` reports language readiness, semantic
  readiness, Tree-sitter/source fallback readiness, and checker availability.
- `src/runtime/project-setup.ts` owns the non-interactive setup workflow plus a
  guided planner used by `scip-query setup --guided` for consent-first changes.
  Every action and result is classified as a repository record, a
  checkout-local preference, or a user-environment change. Indexer consent
  controls external compiler remediation, while the AST-parser choice probes
  and repairs missing pinned Tree-sitter packages inside scip-query's own
  installation. Setup persists the demand-started indexing policy, proves the
  service's clean-idle lifecycle from live state, and reports Rust's final
  semantic transport, lifecycle state, and worker fallback after health. The
  status read is passive; semantic health work may wake the helper.

## Product Decisions

### Keep ts-morph as the TypeScript baseline

Do not rip out ts-morph. It is the current trusted TypeScript semantic oracle:
compiler-backed, in-process, and already integrated with the cache and detector
paths.

`tsserver` is worth exploring as a faster warmed TypeScript language server, but
it should start as a comparison provider. It can replace specific TypeScript
operations only after it matches or beats ts-morph on calibration repositories.

### Make Rust parity real before broadening claims

Rust references now exist, but Rust is not yet TypeScript-parity. Parity means:

- references and caller files;
- callees and call hierarchy;
- signatures;
- import/module/use facts;
- macro-aware behavior where `rust-analyzer` exposes it;
- persistent semantic evidence products;
- capability reporting that distinguishes available, partial, cached, and
  fallback-only facts.

### Speed comes from batching, caching, then persistence

The current Rust path is accurate-first but slow because cold `rust-analyzer`
startup dominates. The safe order is:

1. cache Rust semantic references with a Rust-aware evidence key;
2. batch Rust semantic requests across a whole command or detector phase;
3. introduce a command-scoped semantic session manager;
4. add a cross-command local daemon only after lifecycle and invalidation rules
   are clear.

This order works with the current synchronous semantic-provider contract. A
daemon may be the eventual shape, but it should not be the first move.

### Setup should become interactive and local

`scip-query setup` should gain a guided menu that detects the project and asks
before it changes anything. The flow should cover:

- detected languages and missing indexers;
- missing Tree-sitter native runtime or grammars;
- existing `AGENTS.md`, `CLAUDE.md`, both, or neither;
- whether to update existing agent docs;
- whether to create a missing agent doc;
- whether to install project-local hooks;
- whether to run an initial reindex;
- whether to enable semantic providers and install their dependencies;
- a final smoke test and plain-language readiness report.

### Native Rust remains a measured acceleration path

The CLI should not be converted to Rust wholesale first. The first native Rust
targets should be stable hot kernels: graph traversals, SQLite row aggregation,
source tokenization, semantic materialization helpers, git-history aggregation,
and maybe a future semantic daemon. The TypeScript CLI remains the product
surface until a benchmark says that surface is the bottleneck.

## Direction Ledger

### D1: Semantic evidence products for both TypeScript and Rust

Current pressure: TypeScript semantic references can be cached; Rust references
currently hit `rust-analyzer` again when a command cannot reuse process-local
state.

Direction: extend the semantic reference evidence product so Rust can persist
reference results. The key must include project fingerprint, source identity,
definition identity, language, semantic engine name/version, relevant Cargo
metadata/config identity, and payload version.

Disposition: this is the best first speed slice because it improves repeat
commands without changing the whole semantic-provider API.

2026-07-08 status: shipped for Rust references, Rust import usage, Rust
signatures, and Rust semantic callees. Rust references and callees use
dedicated semantic tables; Rust import usage and signatures use project-scoped
evidence products.

### D2: Command-scoped Rust semantic batching

Current pressure: full commands can ask semantic evidence from several detector
paths. If each path creates a fresh Rust LSP batch, the command pays multiple
project-load costs.

Direction: collect Rust definitions for a command or phase and ask
`rust-analyzer` once per Cargo session root. Feed the result into the semantic
evidence product so later detector calls read cached facts.

Disposition: do this before a daemon. It is easier to test and respects the
current synchronous provider shape.

2026-07-08 status: command-scoped Rust session reuse is shipped inside the Rust
provider. Cross-command reuse is currently delivered by durable evidence caches,
not by a daemon.

### D3: Persistent semantic session manager

Current pressure: one LSP startup per command is still expensive on large Rust
projects.

Direction: introduce a semantic session manager that owns project-scoped
sessions for engines such as `rust-analyzer` and, experimentally, `tsserver`.
Start with command-scoped sessions. Later, consider a local daemon for
cross-command reuse.

Disposition: the session manager should sit behind provider/cache boundaries,
not inside cleanup detectors.

2026-07-08 status: command-scoped session manager and Rust session sidecar are
shipped. A cross-command daemon remains future work.

### D4: tsserver comparison provider, not ts-morph replacement

Current pressure: TypeScript may also benefit from a warmed language server, but
ts-morph is already robust.

Direction: build an optional `tsserver` provider in compare mode. For a chosen
calibration set, ask both ts-morph and tsserver for references/callees/signatures
and record diffs. Switch no default behavior until diff rates are understood and
acceptable.

Disposition: speed cannot buy TypeScript regressions. The first comparison
slice matches ts-morph reference answers on the semantic fixture; broader
calibration must happen before any default changes.

### D5: Guided setup

Current pressure: people miss install warnings, skip Tree-sitter setup, and may
not want agent files created without consent.

Direction: make setup a local guided flow with a non-interactive mode preserved
for CI. The menu should present detected facts, ask consent for local changes,
install missing tooling where possible, and finish with a readiness matrix.

Disposition: make the user experience boring, explicit, and reversible. The
first guided planner covers existing agent docs, optional agent-doc creation,
project hooks, missing indexers, and missing parser runtimes.

### D6: Full mode as one budget policy

Current pressure: some detector profiles still disable semantic evidence for
heavy operations, so full mode can be full in name but not in evidence.

Direction: centralize the analysis budget. Bounded mode can cap and skip; full
mode should use registered semantic evidence unless the provider is unavailable
or the user explicitly disables it.

Disposition: do this after Rust semantic caching/batching exists, so full mode
does not become unusably slow.

2026-07-08 calibration note: large repositories still default to
`semanticEnrichment: false`; `--full` is required to exercise Rust semantic
facts in those commands. The cache timings below make full mode much more
realistic, but centralizing the budget policy remains a next slice.

2026-07-08 full-pass cache note: VegaAssistant full-mode warm-cache runs now
batch semantic callee/reference cache reads by file. Output hashes stayed
identical while `complexity-hotspots --json --full` improved from 34.2s to
8.2s, `similar --json --full` from 57.6s to 2.7s, and uncached
`health --full --json` from 83.0s profiled to 11.3s profiled. Details live in
`docs/benchmarks/2026-07-08-full-pass-optimization-ledger.md`.

### D7: Native Rust kernels after measurement

Current pressure: the user wants the CLI to become as fast as possible, and some
hot paths are likely better as Rust kernels.

Direction: use profiling to select native targets. Prefer small stable
interfaces and fixture-driven equivalence tests. Keep command orchestration,
human output, setup prompts, config, and docs in TypeScript until a measured
reason says otherwise.

Disposition: native conversion is a performance technique, not the architecture
itself. The first SCIP symbol leaf-name kernel is equivalent on fixtures, but as
a helper binary it measured slower than JavaScript for 100k symbols
(`leafName`: about 24ms in JS, about 340ms through the Rust helper). That result
argues against tiny helper-binary kernels and for either larger batch kernels or
in-process native embedding.

2026-07-09 status: a larger `consumer-classify` Rust batch kernel was added and
tested behind `SCIP_QUERY_NATIVE_CONSUMER_CLASSIFY=1`. It preserves
VegaAssistant hashes for `health --full --json`,
`wrapper-candidates --json --full`, and `stale-abstractions --json --full`, but
the helper-process boundary still does not materially beat TypeScript. Direct
detector smokes were slightly slower with Rust opt-in, so the default remains
TypeScript. The next Rust-native speed slice should move a larger contiguous
phase across the boundary or use a lower-overhead native boundary such as a
persistent worker, in-process native module, or daemon design.

## Calibration Results

Measured on 2026-07-08 with local `dist/cli.js`, `SCIP_RUST_SEMANTIC_SETTLE_MS=0`,
and `SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS=1000`.

| Repo          | Index state                                                                    | Query                                                          | First run | Warm repeat | Semantic/cache evidence                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| scip-query    | 293 docs, 18,234 symbols, fresh                                                | `imports crates/scip-query-kernels/src/main.rs --json`         | 6.301s    | 0.624s      | First run: 1 Rust import-definition request, 6.064s, project cache miss. Warm run: project cache hit, 0 Rust import-definition requests.                                 |
| scip-query    | same                                                                           | `call-graph leaf_name --full --json`                           | 0.405s    | 0.420s      | Returned 6 callees. Both runs were served from existing semantic callee cache rows; no Rust session requests.                                                            |
| VegaAssistant | 708 docs, 41,475 symbols, fresh                                                | `imports src-tauri/src/gateway_agent_runtime.rs --full --json` | 9.905s    | 0.232s      | 7 imports, 6 project-local. First run: 1 Rust import-definition request, 9.658s, project cache miss. Warm run: project cache hit, 0 Rust import-definition requests.     |
| VegaAssistant | same                                                                           | `call-graph build_system_prompt_with_options --full --json`    | 19.224s   | 0.472s      | Returned 4 callers and 2 callees. First run: 1 Rust session request, 18.721s, callee cache miss. Warm run: callee cache hit, 0 Rust session requests.                    |
| codex-rs      | 2,473 docs, 72,166 symbols, partial: TypeScript/Rust/Python indexed, C skipped | `imports core/src/client.rs --full --json`                     | 22.337s   | 0.277s      | 103 imports, 77 project-local. First run: 1 Rust import-definition request, 22.052s, project cache miss. Warm run: project cache hit, 0 Rust import-definition requests. |
| codex-rs      | same                                                                           | `call-graph ModelClient::new --full --json`                    | 43.205s   | 1.297s      | Returned 42 callers and 9 callees. First run: 1 Rust session request, 21.057s, callee cache miss. Warm run: callee cache hit, 0 Rust session requests.                   |

Codex setup note: the repo's `rust-toolchain.toml` selects toolchain `1.93.0`
without the `rust-analyzer` component. Calibration used `RUSTUP_TOOLCHAIN=stable`
so the installed stable `rust-analyzer 1.92.0` could index and answer semantic
queries without editing Codex files. Cold `codex-rs` indexing with
`--allow-partial` took 250.9s and skipped only C.

Accuracy notes:

- scip-query import semantics resolved the project-local `leaf_name` import to
  `crates/scip-query-kernels/src/lib.rs` while keeping `std::io` imports
  external.
- VegaAssistant and Codex import semantics resolved project-local Rust imports
  on the first full run, then served identical import counts from the durable
  project cache on the second run.
- Codex initially did not cache Rust import usage because intentional partial
  indexes had no project evidence fingerprint. That was fixed by accepting
  `status: "partial"` metadata and including the status in project cache
  identity, preventing partial and complete indexes from sharing rows.

## Recommended First Slice

Start with Rust semantic reference caching and command-level batching.

Why this first:

- it attacks the current measured pain: repeated `rust-analyzer` startup;
- it preserves ts-morph and TypeScript behavior;
- it improves real Rust semantic accuracy usage without claiming broader parity;
- it is testable with the existing VegaAssistant smoke;
- it creates the evidence-product foundation a later persistent session manager
  and daemon both need.

The first slice should answer:

- How many Rust semantic batches does one full command issue today?
- Which definitions can be cached safely?
- What cache identity is needed for Cargo/rust-analyzer correctness?
- How much faster is a warm repeat command on VegaAssistant?
- Which misses are true semantic misses versus provider/load/timeouts?

## What Not To Do

- Do not replace ts-morph with tsserver until a compare provider proves parity.
- Do not jump straight to a daemon before cache identity and command-scoped
  batching exist.
- Do not let cleanup detectors learn Rust-specific semantic details directly.
- Do not create `CLAUDE.md`, `AGENTS.md`, or hooks in setup without asking.
- Do not treat Tree-sitter install warnings as enough UX.
- Do not remove bounded/full limits by only changing constants.
- Do not convert the whole CLI to Rust before profiling identifies stable
  kernels.

## Success Signals

- On VegaAssistant, a repeated Rust semantic caller-map command is mostly cache
  hits and no longer pays a full `rust-analyzer` startup for already-known
  references.
- Rust semantic capability reporting says which fact slots are implemented:
  references, callees, signatures, import/module facts.
- TypeScript semantic behavior remains unchanged unless `tsserver` compare mode
  is explicitly enabled.
- `scip-query setup` can walk a user through indexers, Tree-sitter parsers,
  semantic engines, hooks, and agent docs with consent before file changes.
- Full mode becomes meaningfully full: when semantic evidence is available and
  cached, heavy operations use it instead of silently turning it off.
- Native Rust work starts with measured kernels and fixture equivalence tests,
  not a broad rewrite.
