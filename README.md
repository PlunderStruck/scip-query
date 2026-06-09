# scip-query

Structural code intelligence for AI agents and engineers.

`scip-query` lets a model ask precise questions about how a codebase is wired together: where a symbol is defined, who references it, what calls it, what it calls, what depends on it, and what would be affected by changing it. It uses [SCIP](https://github.com/sourcegraph/scip) indexes, so the strongest answers come from compiler and language-server facts instead of text search.

Works with every language that has a SCIP indexer: TypeScript, JavaScript, Vue, Java, Scala, Kotlin, Rust, Python, Ruby, Go, C/C++, C#, Visual Basic, Dart, PHP.

## Install

```bash
npm install -g scip-query@latest
scip-query --version
```

Or run it without a global install:

```bash
npx scip-query@latest --version
npx scip-query@latest reindex
```

## The Problem

A codebase is a set of source files connected by definitions, references, imports, calls, exports, and dependency paths. Those relationships are what make a program changeable: before editing one unit, you need to know what it is, who uses it, and what behavior or API surface depends on it.

AI agents often lose that thread. Reading files directly gives local text, but not the verified structure around that text. Search finds matching words, but not whether a match is a real reference. Summaries compress too early and can hide the exact line, symbol, or consumer that matters.

`scip-query` exists to give agents and humans a better primitive: structural questions with evidence-backed answers. A structural question is a question about relationships inside code, such as "who calls this?", "what imports this?", "what is downstream of this API?", or "which unused exports are only kept alive by a barrel file?" The answer should name concrete files, symbols, line ranges, and confidence boundaries, so the next edit can be planned and verified without guessing.

## What It Does

`scip-query` indexes a project once, then exposes code relationships as terminal commands:

```bash
scip-query system src/auth          # map a module end to end
scip-query trace login              # definition plus real references
scip-query call-graph login         # incoming callers and outgoing callees
scip-query affected login           # transitive blast radius
scip-query change-surface src/auth/service.ts
scip-query diff-impact              # downstream consumers of current git changes
```

Those traces are also the basis for cleanup:

```bash
scip-query health
scip-query dead --min-loc 10 --skip-barrels
scip-query similar --min-similarity 0.5
scip-query stale-abstractions
scip-query drift
```

Cleanup findings are not magic deletion instructions. They are structural leads: symbols with no consumers, functions with similar dependency fingerprints, abstractions with too few users, dependency cycles, pattern drift, and other relationships that point to simpler code.

## Accuracy Model

A SCIP index is a database-shaped record of code facts produced by language-aware tooling: files, definitions, symbols, and resolved references. Because those facts come from compilers, type checkers, or language servers, direct definition and reference queries are stronger evidence than grep-style text matches.

`scip-query` keeps evidence levels separate:

- Compiler-backed facts come from the SCIP database. Commands like `symbols`, `refs`, `trace`, `deps`, `rdeps`, `system`, `surface`, and many symbol counts start here.
- Semantic augmentation adds language-specific checks when available. TypeScript projects use `ts-morph` to verify references, imports, callers, callees, and signatures when SCIP alone is incomplete.
- Source-backed heuristics use parsed source text or ASTs for higher-level cleanup signals when an indexer omits details. These results are candidates to inspect, not blind refactoring orders.

The goal is simple: use the strongest available evidence first, make fallback behavior explicit, and keep the model attached to the real structure of the code.

## Quick Start

```bash
scip-query check-deps
scip-query install-skills
scip-query reindex

scip-query stats
scip-query system src/auth
scip-query trace login
scip-query affected login
scip-query health
```

## Prerequisites

- Node.js >= 18
- `scip` CLI, from [Sourcegraph SCIP releases](https://github.com/sourcegraph/scip/releases)
- A language-specific SCIP indexer for your project

| Language | Indexer | Install |
|---|---|---|
| TypeScript / JavaScript / Vue | scip-typescript | `npm install -g @sourcegraph/scip-typescript` |
| Java / Scala / Kotlin | scip-java | [releases](https://github.com/sourcegraph/scip-java/releases) |
| Rust | rust-analyzer | Ships with rust-analyzer: `rust-analyzer scip` |
| Python | scip-python-plus | `npm install -g scip-python-plus` |
| Go | scip-go | `go install github.com/sourcegraph/scip-go@latest` |
| Ruby | scip-ruby | [releases](https://github.com/sourcegraph/scip-ruby/releases) |
| C / C++ | scip-clang | [releases](https://github.com/sourcegraph/scip-clang/releases) |
| C# / VB | scip-dotnet | [releases](https://github.com/sourcegraph/scip-dotnet/releases) |
| Dart | scip-dart | [releases](https://github.com/nicovince/scip-dart/releases) |
| PHP | scip-php | [releases](https://github.com/nicovince/scip-php/releases) |

For Python, the executable may be `scip-python`, `scip-python-plus`, or both. `scip-query` accepts either name.

Vue single-file components are handled through the JavaScript/TypeScript indexer. `scip-query` also extracts the `<script>` or `<script setup>` block so symbol, reference, and import queries cover Vue components alongside regular `.ts` and `.js` files.

## How It Works

1. A SCIP indexer analyzes source code with the actual compiler, type checker, or language server and produces `index.scip`.
2. The `scip` CLI converts that protobuf file to a SQLite database: `index.db`.
3. `scip-query` runs SQL queries and language-aware source augmentation against the database.

By default, indexes live in `~/.cache/scip-query/projects/<hash>/`, keeping project directories clean. Override paths with `.scipquery.json` or `SCIP_QUERY_*` environment variables.

## Configuration

Run this in a project root:

```bash
scip-query init
```

It creates `.scipquery.json`:

```json
{
  "languages": ["typescript"],
  "watch": {
    "enabled": false,
    "debounceMs": 30000,
    "cooldownMs": 60000
  },
  "indexer": {
    "typescript": {
      "pnpmWorkspaces": true
    }
  }
}
```

Useful environment variables:

| Variable | Purpose |
|---|---|
| `SCIP_QUERY_PROJECT_ROOT` | Override the project root directory |
| `SCIP_QUERY_INDEX_DB` | Override the SQLite database path |
| `SCIP_QUERY_INDEX_SCIP` | Override the SCIP protobuf path |
| `SCIP_QUERY_CACHE_DIR` | Override the cache directory |

Query results are filtered through the project's `.gitignore`. If none exists, common generated directories such as `dist/`, `target/`, `node_modules/`, and `.venv/` are excluded by default.

## Documentation

- [Agent Guide](docs/AGENT_GUIDE.md): goal-oriented workflows for tracing, planning, cleanup, quality checks, and change verification.
- [Command Reference](docs/COMMAND_REFERENCE.md): generated command syntax, descriptions, and options.
- [Programmatic API](docs/API.md): using the query functions from TypeScript.
- [Historical plans](docs/plans/): implementation notes and completed cleanup plans.

## License

Apache-2.0
