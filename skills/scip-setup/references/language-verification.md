# Language-specific verification

Used in bootstrap workflow step 4, and any time an index or capability report
looks wrong for a specific language.

## TypeScript, JavaScript, and Vue

Require these capability rows to explain their state:

- `scip-typescript` is runnable for SCIP indexing;
- the detected Tree-sitter TypeScript/JavaScript parser is available for
  source facts;
- ts-morph semantic readiness is available for TypeScript;
- the demand-started service is enabled and status exposes TypeScript
  semantic and TypeScript index session counters.

For a real multi-project TypeScript monorepo, set
`indexer.typescript.projectMode: "workspace"`. This makes project/tsconfig
boundaries the sub-shards, so a changed project and its project-reference,
workspace-package, or tsconfig-path dependents rebuild while unrelated
project shards are reused. Use `indexer.typescript.projects` only when
automatic discovery is too broad; a non-empty list there is authoritative.

Do not enable TypeScript workspace mode for a single-project repository
merely to seek speed — the normal incremental document producer and
persistent ts-morph service already reuse unchanged work.

## Rust

Require these distinct facts:

- `rust-analyzer` is runnable and supports `rust-analyzer scip` for indexing;
- the Tree-sitter Rust grammar is available for source facts;
- Rust semantic readiness is available for compiler-backed references,
  callees, signatures, and module/use evidence;
- status reports the durable Rust transport with worker fallback.

A `stopped` state for the Rust transport (or any demand-started helper) is
healthy when no semantic request currently needs the clean-idle helper —
lifecycle state is not the same signal as capability availability.

If `rust-analyzer` is missing and `rustup` is available, `setup` can run
`rustup component add rust-analyzer`. `SCIP_RUST_SEMANTIC_DURABLE_SESSION=0`
is an explicit worker-only fallback, not the optimal default — do not set it
as a default recommendation.

## Other languages

Trust the capability matrix, not a language name. `setup` may install
supported indexers automatically (for example Python or Go), may provide only
source facts through a detected Tree-sitter grammar, or may report a manual
install URL. A missing semantic provider must be reported as unsupported,
never as a clean semantic analysis.

## Verification commands

```bash
scip-query status --capabilities
scip-query reindex --json
scip-query watch --status --json
```
