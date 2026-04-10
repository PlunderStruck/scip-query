# scip-query

Language-agnostic code intelligence CLI powered by [SCIP](https://github.com/sourcegraph/scip) indexes. Index any codebase, then query it for references, dependencies, dead code, similarity, coupling, and more — without an IDE or language server running.

Works with every language that has a SCIP indexer: TypeScript, JavaScript, Java, Scala, Kotlin, Rust, Python, Ruby, Go, C/C++, C#, Dart, PHP.

## Workflows

For goal-oriented usage guides (not just command reference), see **[Agent Guide](docs/AGENT_GUIDE.md)**:

- **[Understand a system](docs/AGENT_GUIDE.md#workflow-1-understand-a-system-before-making-changes)** — map a module, trace symbols, check blast radius
- **[Write an implementation plan](docs/AGENT_GUIDE.md#workflow-2-write-a-concrete-implementation-plan)** — identify contracts, map dependencies, find reusable code
- **[De-bloat a codebase](docs/AGENT_GUIDE.md#workflow-3-clean-up-and-de-bloat-a-codebase)** — prioritized cleanup from dead code to pattern drift
- **[Assess code quality](docs/AGENT_GUIDE.md#workflow-4-assess-code-quality-and-risk)** — health score, complexity hotspots, coupling risks
- **[Verify change impact](docs/AGENT_GUIDE.md#workflow-5-understand-impact-after-making-changes)** — diff impact, transitive blast radius, test gaps

## Quick Start

```bash
# Install
npm install -g scip-query

# Index your project (auto-detects language)
scip-query reindex

# Start querying
scip-query stats
scip-query health                        # full codebase health report
scip-query symbols src/auth.service.ts
scip-query refs login
scip-query affected login                # transitive blast radius
scip-query dead --min-loc 10
scip-query similar --min-similarity 0.5
scip-query diff-impact                   # what did my changes affect?
```

## Prerequisites

- **Node.js** >= 18
- **scip** CLI — [Install from releases](https://github.com/sourcegraph/scip/releases) (converts index to SQLite)
- A language-specific SCIP indexer for your project:

| Language | Indexer | Install |
|---|---|---|
| TypeScript / JavaScript | scip-typescript | `npm install -g @sourcegraph/scip-typescript` |
| Java / Scala / Kotlin | scip-java | [releases](https://github.com/sourcegraph/scip-java/releases) |
| Rust | rust-analyzer | Ships with rust-analyzer (`rust-analyzer scip`) |
| Python | scip-python-plus | `npm install -g scip-python-plus` |
| Go | scip-go | `go install github.com/sourcegraph/scip-go@latest` |
| Ruby | scip-ruby | [releases](https://github.com/sourcegraph/scip-ruby/releases) |
| C / C++ | scip-clang | [releases](https://github.com/sourcegraph/scip-clang/releases) |
| C# / VB | scip-dotnet | [releases](https://github.com/sourcegraph/scip-dotnet/releases) |
| Dart | scip-dart | [releases](https://github.com/nicovince/scip-dart/releases) |
| PHP | scip-php | [releases](https://github.com/nicovince/scip-php/releases) |

## How It Works

1. A SCIP indexer analyzes your source code using the actual compiler/type checker and produces a `index.scip` protobuf file containing every symbol, definition, and reference — fully type-resolved.
2. The `scip` CLI converts the protobuf to a SQLite database (`index.db`).
3. `scip-query` runs SQL queries against that database to answer questions about your codebase.

Because the index comes from the real compiler, results are precise — not grep-based approximations. A reference to `login()` in file A is provably the same `login()` defined in file B, not just a string match.

## Configuration

### Per-project config

Run `scip-query init` to generate a `.scipquery.json` in your project root:

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

### Environment variables

| Variable | Purpose |
|---|---|
| `SCIP_QUERY_PROJECT_ROOT` | Override the project root directory |
| `SCIP_QUERY_INDEX_DB` | Override the SQLite database path |
| `SCIP_QUERY_INDEX_SCIP` | Override the SCIP protobuf path |
| `SCIP_QUERY_CACHE_DIR` | Override the cache directory |

### Index storage

By default, indexes are stored in `~/.cache/scip-query/projects/<hash>/` (following XDG conventions). This keeps your project directory clean. Override with the `dbPath` field in `.scipquery.json` or the `SCIP_QUERY_CACHE_DIR` environment variable.

### Gitignore integration

All query results are filtered through your project's `.gitignore`. Build artifacts (`dist/`, `target/`, `__pycache__/`), dependency directories (`node_modules/`, `vendor/`), and virtual environments (`.venv/`) are automatically excluded. If no `.gitignore` exists, sensible defaults are applied.

---

## Command Reference

### Index Management

#### `reindex`

Index (or re-index) the codebase. Auto-detects which languages are present, runs the appropriate SCIP indexer, and converts the output to SQLite.

```bash
scip-query reindex
scip-query reindex --language typescript
scip-query reindex --pnpm-workspaces        # for pnpm monorepos
```

**Options:**
- `-l, --language <lang>` — Index only this language (can repeat)
- `--pnpm-workspaces` — Enable pnpm workspace support (TypeScript)

**When to use:** After significant code changes, after pulling, or before running analysis commands for the first time.

---

#### `watch`

Watch the project for file changes and automatically reindex in the background. Uses a single-flight model: only one reindex runs at a time, changes during reindex set a dirty flag for one follow-up run.

```bash
scip-query watch
scip-query watch --debounce 60000           # wait 60s after last change
```

**Options:**
- `--debounce <ms>` — Milliseconds to wait after the last file change before reindexing (default: 30000)
- `--cooldown <ms>` — Minimum milliseconds between reindex completions (default: 60000)

**How it works:** Watches for file changes (respecting `.gitignore`), debounces, runs reindex in a child process writing to a temp file, then atomically swaps the database. Queries against the old index continue working during reindex — no downtime.

---

#### `status`

Show the current index status: where it's stored, how big it is, when it was built.

```bash
scip-query status
```

---

#### `stats`

Show index statistics: document count, symbol count, definition count, reference count, database size.

```bash
scip-query stats
# Documents:   42
# Symbols:     1111
# Definitions: 803
# References:  2094
# Index size:  660 KB
# Last built:  2026-04-10 16:12:58
```

**Value:** Quick sanity check that your index is healthy and up to date.

---

#### `init`

Create a `.scipquery.json` config file in the project root with auto-detected languages and default settings.

```bash
scip-query init
```

---

### Navigation

These commands help you understand and navigate the codebase — find where things are defined, where they're used, and how files relate to each other.

#### `files <pattern>`

Find indexed files matching a path pattern.

```bash
scip-query files auth              # all files with "auth" in the path
scip-query files .service.ts       # all service files
```

**Value:** Quick file discovery without leaving the terminal. Respects gitignore.

---

#### `symbols <file>`

List all symbols defined in a file with their line ranges and type signatures.

```bash
scip-query symbols auth.service.ts
#   1-50   AuthService  — class AuthService
#   5-20   AuthService:login()  — login(email: string): Promise<Token>
#   22-35  AuthService:logout()  — logout(): void
```

**Value:** Instant overview of a file's API surface — like a table of contents with type information. Faster than reading the file.

---

#### `methods <className>`

List all methods of a class with their line ranges.

```bash
scip-query methods AuthService
#   5-20   login
#   22-35  logout
```

**Value:** Quick method inventory for a class. Useful when you need to know what a class can do without reading its full source.

---

#### `refs <symbol>`

Find every file that references a symbol, grouped by file with line numbers.

```bash
scip-query refs login
# src/controllers/auth.controller.ts
#   line 15
# src/__tests__/auth.test.ts
#   line 8
```

**Value:** "Who uses this?" — the most fundamental code intelligence question. Compiler-resolved, so no false positives from string matches.

---

#### `trace <symbol>`

Show a symbol's definition (with signature) and every file that references it. Like `refs` but also shows you where the symbol is defined.

```bash
scip-query trace parseSymbol
# ═══ DEFINITION ═══
#   src/symbol-parser.ts:35-99  — parseSymbol(raw: string): ScipSymbol | ScipLocalSymbol
#
# ═══ REFERENCED BY ═══
#   src/index.ts
#   src/symbol-parser.ts
```

**Value:** End-to-end symbol investigation. Answers "where is this defined, what's its signature, and who uses it?" in one command.

---

#### `outline <file>`

Tree-structured view of all symbols in a file, using parent-child nesting when the indexer provides `enclosing_symbol` data.

```bash
scip-query outline db.ts
# 0-111  src:db
# 19-110  src:db:ScipDatabase
#   24-29  src:db:ScipDatabase:constructor()
#   32-34  src:db:ScipDatabase:setPathFilter()
```

**Value:** Visual file structure at a glance — like an IDE's outline panel but in the terminal.

---

#### `hierarchy <symbol>`

Show a symbol's ancestry chain — from the symbol up through its enclosing scopes (method → class → module → file).

```bash
scip-query hierarchy login
# src:auth:AuthService:login()
#   src:auth:AuthService
```

**Value:** Understand where a symbol lives in the nesting hierarchy. Requires the indexer to populate `enclosing_symbol`.

---

#### `members <symbol>`

Find all direct children of a symbol (methods, fields, nested types) using the enclosing_symbol relationship.

```bash
scip-query members AuthService
#   5-20   [method]  login
#   22-35  [method]  logout
#   37-37  [term]    tokenSecret
```

**Value:** Like `methods` but includes fields, nested types, and anything else directly inside a symbol. Requires `enclosing_symbol` support from the indexer.

---

#### `call-graph <symbol>`

Show what calls a symbol (incoming) and what the symbol calls (outgoing).

```bash
scip-query call-graph shortenSymbol
# Symbol: src:symbol-parser:shortenSymbol()
#
# ═══ CALLERS (16) ═══
#   src/queries/dead.ts        src:queries:dead
#   src/queries/hotspots.ts    src:queries:hotspots
#   ...
#
# ═══ CALLEES (0) ═══
```

**Value:** Understand a function's role in the call chain. High caller count = widely used, be careful changing it. Many callees = complex function, may need decomposition.

---

### Dependency Analysis

These commands map how files and modules depend on each other — forward deps, reverse deps, and full module maps.

#### `deps <file>`

List all internal files that this file depends on (forward dependencies).

```bash
scip-query deps cli.ts
# src/config.ts
# src/db.ts
# src/queries/index.ts
# src/reindex/index.ts
```

**Value:** "What does this file need to work?" Useful before refactoring — tells you what you're coupled to.

---

#### `rdeps <file>`

List all files that depend on this file (reverse dependencies).

```bash
scip-query rdeps symbol-parser
# src/index.ts
# src/queries/dead.ts
# src/queries/hotspots.ts
# ...
```

**Value:** "Who breaks if I change this?" The blast radius of a modification. High rdeps count = be very careful with changes.

---

#### `system <module>`

Full module map: all files in the module, all exported symbols, all inbound and outbound dependencies.

```bash
scip-query system queries
# ═══ FILES ═══
# src/queries/dead.ts
# src/queries/deps.ts
# ...
#
# ═══ EXPORTED SYMBOLS ═══
#   8-124  dead()
#   4-23   deps()
# ...
#
# ═══ DEPENDS ON (internal) ═══
#   src/db.ts
#   src/symbol-parser.ts
#
# ═══ DEPENDED ON BY ═══
#   src/cli.ts
#   src/index.ts
```

**Value:** Complete module overview in one command. Shows the module's interface, its internal structure, and its position in the dependency graph.

---

#### `surface <module>`

What symbols do external consumers actually use from this module? The true public API — not what's exported, but what's actually imported and referenced by other modules.

```bash
scip-query surface db.ts
#   src/cli.ts → ScipDatabase
#   src/cli.ts → ScipDatabase:close()
#   src/queries/dead.ts → ScipDatabase:all()
#   src/queries/dead.ts → ScipDatabase:isIgnored()
```

**Value:** Distinguish "exported" from "actually used." If you export 20 symbols but only 5 are referenced externally, the other 15 are candidates for removal or making private.

---

#### `imports <file>`

What symbols does this file import? Uses SCIP `role=2` (import) mentions.

```bash
scip-query imports auth.controller.ts
#   AuthService:login()  ← src/services/auth.service.ts
#   validateInput()      ← src/utils/validation.ts
```

**Value:** Quick import inventory. Note: depends on the indexer emitting `role=2` — not all do (e.g., `scip-typescript` currently doesn't).

---

#### `imported-by <symbol>`

Which files import this symbol?

```bash
scip-query imported-by AuthService
#   src/controllers/auth.controller.ts
#   src/__tests__/auth.test.ts
```

---

#### `unused-imports <file>`

Find imports in a file that are never referenced in the same file — likely unused imports that should be cleaned up.

```bash
scip-query unused-imports auth.controller.ts
#   formatDate  in src/controllers/auth.controller.ts
# 1 unused import(s)
```

**Value:** Automated unused import detection. Note: same `role=2` limitation as `imports`.

---

### Code Quality & Dead Code

These commands find code that can be removed, consolidated, or cleaned up.

#### `dead [scope]`

Find dead exports: symbols defined locally with no cross-file references. Distinguishes between "dead code" (not referenced anywhere, even in the same file) and "dead exports" (used locally but never imported by other files).

```bash
scip-query dead --min-loc 10
scip-query dead src/utils --skip-barrels --include-members
```

**Options:**
- `--min-loc <n>` — Only show symbols >= N lines (default: 1)
- `--include-tests` — Include test files in results (excluded by default)
- `--skip-barrels` — Ignore references from barrel re-export files (index.ts)
- `--include-members` — Include class members (module-level only by default)

**Value:** Find code you can delete. The `--skip-barrels` flag is key — without it, symbols re-exported through index.ts appear "referenced" even if no real consumer uses them.

---

#### `isolated`

Find completely orphaned symbols: defined locally, not referenced by anything (not even in the same file), and not referencing anything external. These are truly disconnected from the codebase graph.

```bash
scip-query isolated --min-loc 5
scip-query isolated --scope src/utils
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--min-loc <n>` — Minimum lines of code (default: 3)

**Value:** Stricter than `dead` — these symbols serve no purpose at all. Safe deletion candidates.

---

#### `doc-coverage`

Check what percentage of symbols have documentation strings. Lists undocumented symbols.

```bash
scip-query doc-coverage --min-loc 5
# Documentation coverage: 78%
#   Total symbols:   122
#   Documented:      95
#   Undocumented:    27
#
# Undocumented:
#   src/utils/format.ts:15  formatCurrency
#   src/utils/format.ts:28  formatDate
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--min-loc <n>` — Minimum LOC to consider (default: 3)
- `-n, --limit <n>` — Max undocumented symbols to show (default: 50)

**Value:** Documentation health check. Focus efforts on the undocumented list.

---

#### `test-coverage [symbol]`

Check if symbols are referenced by test files. Without a symbol argument, shows a summary percentage. With a symbol, shows which specific test files cover it.

```bash
scip-query test-coverage
# Test coverage: 45%
#   Total symbols:  95
#   Covered:        43
#   Not covered:    52

scip-query test-coverage AuthService
#   [covered]      AuthService  (src/services/auth.service.ts)
#     ← src/__tests__/auth.test.ts
#   [NOT COVERED]  AuthService:logout()  (src/services/auth.service.ts)
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--min-loc <n>` — Minimum LOC for summary mode (default: 3)

**Value:** Reference-based test coverage — which symbols does your test suite actually exercise? Not execution coverage, but structural coverage: "do tests at least reference this code?"

---

### Codebase Metrics

These commands measure structural properties of the codebase — hotspots, coupling, bottlenecks, fan-in/out.

#### `hotspots`

Find the most-referenced symbols in the codebase. These are the choke points where changes have the widest blast radius.

```bash
scip-query hotspots -n 15
#   refs  files  symbol
#   ────  ─────  ──────
#     39     39  src:types
#     33     31  src:db:ScipDatabase
#     27     27  src:db:ScipDatabase:all()
```

**Options:**
- `-n, --limit <n>` — Number of results (default: 30)
- `-s, --scope <path>` — Limit to files matching path

**Value:** Identify the symbols where a bug or breaking change would affect the most consumers. Hotspots deserve the most careful review, the best test coverage, and the most stable interfaces.

---

#### `fan-in [symbol]`

How many distinct files reference a symbol. Without an argument, shows the top N symbols by fan-in across the codebase.

```bash
scip-query fan-in ScipDatabase
#    19 files  ScipDatabase
#    16 files  ScipDatabase:all()
#    13 files  ScipDatabase:isIgnored()

scip-query fan-in -n 10
#   files  symbol
#   ─────  ──────
#      31  ScipDatabase
#      27  ScipDatabase:all()
```

**Options:**
- `-n, --limit <n>` — Number of results for top mode (default: 30)
- `-s, --scope <path>` — Limit to files matching path

**Value:** High fan-in = widely depended upon. Changes to high fan-in symbols have large blast radius. These symbols should have stable interfaces and thorough tests.

---

#### `fan-out [file]`

How many external symbols a file references. Without an argument, shows the top N files by fan-out. High fan-out files are fragile — they depend on many things, so upstream changes are more likely to break them.

```bash
scip-query fan-out cli.ts
#    23 symbols  src/cli.ts

scip-query fan-out -n 10
#   symbols  file
#   ───────  ────
#       68  src/queries/index.ts
#       23  src/cli.ts
```

**Options:**
- `-n, --limit <n>` — Number of results for top mode (default: 30)
- `-s, --scope <path>` — Limit to files matching path

**Value:** Identify files that are tightly coupled to the rest of the codebase. High fan-out files are the first to break when dependencies change.

---

#### `bottlenecks`

Find coupling hubs: symbols with both high fan-in (many consumers) AND high fan-out (many dependencies). Score = fan-in × fan-out. These are the most dangerous symbols to change — they sit at the intersection of many dependency paths.

```bash
scip-query bottlenecks -n 10
#   score  fan-in  fan-out  symbol
#   ─────  ──────  ───────  ──────
#     136       2       68  src:queries:index
#     124      31        4  src:db:ScipDatabase
```

**Options:**
- `-n, --limit <n>` — Number of results (default: 20)
- `-s, --scope <path>` — Limit to files matching path
- `--min-fan-in <n>` — Minimum fan-in (default: 2)
- `--min-fan-out <n>` — Minimum fan-out (default: 2)

**Value:** These are the architectural pressure points. A symbol with fan-in=20 and fan-out=5 is both heavily depended upon and heavily dependent — changes to it are risky in both directions.

---

#### `coupling [file1] [file2]`

Measure coupling between two specific files (how many symbols they share), or find the most coupled file pairs across the codebase.

```bash
scip-query coupling db.ts cli.ts
# db.ts ↔ cli.ts: 4 shared symbols

scip-query coupling -n 10
#   shared  file1 → file2
#   ──────  ─────────────
#        5  src/db.ts → src/queries/stats.ts
```

**Options:**
- `-n, --limit <n>` — Number of results for top mode (default: 20)
- `-s, --scope <path>` — Limit to files matching path

**Value:** Quantify how tightly two files are linked. High coupling between files that shouldn't be related is a design smell. Useful for identifying candidates for interface extraction.

---

#### `cycles`

Detect circular dependency chains between files. A cycle exists when file A depends on B, B on C, and C on A.

```bash
scip-query cycles
# No circular dependencies found.

scip-query cycles --scope src/services
# Cycle 1 (3 files):
#   src/services/auth.ts →
#   src/services/user.ts →
#   src/services/auth.ts (cycle)
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--max-depth <n>` — Maximum cycle depth (default: 10)

**Value:** Circular dependencies make code harder to test, harder to understand, and harder to refactor. This command finds them so you can break the cycles.

---

#### `deep-chains`

Find the longest transitive dependency chains in the codebase. A chain A → B → C → D means A depends on B, B on C, C on D.

```bash
scip-query deep-chains -n 5 --min-depth 4
# Chain 1 (depth 5):
#   → src/cli.ts
#   → src/queries/index.ts
#   → src/queries/surface.ts
#   → src/db.ts
#   → src/types.ts
```

**Options:**
- `-n, --limit <n>` — Number of chains to show (default: 10)
- `-s, --scope <path>` — Limit to files matching path
- `--min-depth <n>` — Minimum chain depth (default: 3)

**Value:** Long dependency chains mean changes at the bottom ripple through many layers. If chains are excessively deep, it may indicate that the architecture needs flattening or that intermediate layers aren't adding value.

---

#### `by-kind <kind>`

Find symbols by their SCIP symbol kind (class, interface, enum, function, struct, method, etc.).

```bash
scip-query by-kind class
scip-query by-kind interface --scope src/types
scip-query by-kind 68                          # kind number for Struct
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `-n, --limit <n>` — Number of results (default: 100)

**Value:** Structural inventory — "how many classes do we have?", "where are all the interfaces?", "list every enum." Requires the indexer to populate the `kind` field.

---

#### `kind-counts`

Show a histogram of symbol kinds in the codebase.

```bash
scip-query kind-counts
#   count  kind
#   ─────  ────
#      45  Class (9)
#      23  Interface (27)
#      12  Enum (16)
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path

**Value:** Architectural overview — what types of symbols make up the codebase? Useful for understanding whether a codebase is class-heavy, function-heavy, interface-driven, etc.

---

### Similarity & Consolidation

These commands find duplication, redundancy, and extraction opportunities — the tools for de-bloating a codebase.

#### `similar [symbol]`

Find functions with similar callee fingerprints using Jaccard similarity. Two functions that call the same set of symbols are likely doing the same work and are candidates for consolidation.

Without a symbol argument, finds the top N most similar pairs across the codebase. With a symbol, finds what's most similar to that specific function.

```bash
scip-query similar --min-similarity 0.5
# 80% similar:
#   A: by-kind  (src/queries/by-kind.ts)
#   B: call-graph  (src/queries/call-graph.ts)
#   Shared: ScipDatabase, db.all(), db.get(), db.isIgnored(), shortenSymbol()

scip-query similar dead --min-similarity 0.3
# 64% similar:
#   A: dead  (src/queries/dead.ts)
#   B: bottlenecks  (src/queries/bottlenecks.ts)
#   Shared callees: db, ScipDatabase, db.all(), db.isIgnored(), shortenSymbol()
#   Only in A: DeadOptions, DeadSummary, DeadSymbolResult
#   Only in B: BottleneckResult
```

**Options:**
- `--min-similarity <n>` — Minimum Jaccard similarity 0-1 (default: 0.4)
- `-n, --limit <n>` — Number of results (default: 20)
- `-s, --scope <path>` — Limit to files matching path
- `--min-callees <n>` — Minimum callees to consider a symbol (default: 4)

**Value:** Finds "these two functions do basically the same thing" at scale. The shared callee list shows exactly what's duplicated. The unique callees show where they diverge — that's the parameterization point for a consolidated version.

---

#### `similar-files [file]`

Find files with similar dependency profiles using Jaccard similarity on their dependency sets. Files that import the same modules are structurally doing similar work.

```bash
scip-query similar-files --min-similarity 0.7
# 100% similar:
#   src/queries/symbols.ts
#   src/queries/system.ts
#   Shared deps (4): db.ts, types.ts, symbol-parser.ts, clean-signature.ts

scip-query similar-files auth.controller.ts
```

**Options:**
- `--min-similarity <n>` — Minimum Jaccard similarity 0-1 (default: 0.5)
- `-n, --limit <n>` — Number of results (default: 20)
- `-s, --scope <path>` — Limit to files matching path
- `--min-deps <n>` — Minimum dependencies to consider (default: 3)

**Value:** Finds copy-paste file variants and structurally redundant modules. When two files have 90%+ dependency overlap, they're likely doing similar jobs and should share code or be merged.

---

#### `similar-chains`

Find end-to-end dependency flows through the codebase that are structurally similar but diverge at a few points. Uses edit distance on the file-node sequences.

```bash
scip-query similar-chains --min-similarity 0.5
# ── Chain pair 1 (67% similar, 1 divergence point) ──
#   Chain A: auth.controller.ts → auth.service.ts → user.repo.ts
#   Chain B: org.controller.ts  → org.service.ts  → user.repo.ts
#   Common suffix: user.repo.ts
#   Divergence points (consolidation targets):
#     [0] auth.controller.ts  ↔  org.controller.ts
#     [1] auth.service.ts     ↔  org.service.ts
```

**Options:**
- `--min-similarity <n>` — Minimum chain similarity 0-1 (default: 0.5)
- `-n, --limit <n>` — Number of results (default: 15)
- `-s, --scope <path>` — Limit to files matching path
- `--min-length <n>` — Minimum chain length (default: 3)
- `--max-length <n>` — Maximum chain length (default: 8)

**Value:** This is the most powerful consolidation finder. It detects "you have two parallel end-to-end mechanisms doing the same thing through different code paths." The divergence points are exactly where to extract a shared abstraction. Unlike function-level similarity, this catches architectural-level duplication.

---

#### `extract-candidates`

Find large functions with natural extraction seams — isolated groups of callees that form distinct clusters within a single function. When a function calls symbols A, B, C together and separately calls D, E, F, that's two potential extracted functions.

```bash
scip-query extract-candidates --min-loc 20 --min-callees 6
# src/services/auth.ts:10-85  processAuth  (75 LOC, 12 callees)
#   Cluster 1 (92% isolated, 4 callees):
#     validateToken, parseJwt, checkExpiry, refreshToken
#   Cluster 2 (88% isolated, 3 callees):
#     formatUser, enrichProfile, cacheResult
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--min-loc <n>` — Minimum function LOC (default: 10)
- `--min-callees <n>` — Minimum callees to analyze (default: 6)
- `-n, --limit <n>` — Number of results (default: 20)

**Value:** Identifies concrete extraction opportunities within large functions. Each cluster is a group of callees that are used together but independently from the rest of the function — a natural candidate for "Extract Method" refactoring. The isolation score tells you how cleanly the extraction would separate.

---

### Impact & Planning

#### `affected <symbol>`

Full transitive closure of symbols that could break if this symbol changes. BFS through the mention graph at configurable depth.

```bash
scip-query affected login --max-depth 3
#   ── Depth 1 ──
#   src/controllers/auth.controller.ts  handleLogin
#   src/__tests__/auth.test.ts  authTests
#
#   ── Depth 2 ──
#   src/routes/index.ts  routes
```

**Options:**
- `--max-depth <n>` — Maximum traversal depth (default: 5)
- `-s, --scope <path>` — Limit to files matching path

**Value:** "If I change this, what's the full blast wave?" Goes beyond direct `rdeps` to show consumers-of-consumers.

---

#### `change-surface <file>`

Pre-change briefing for a file: every exported symbol, consumer count, test coverage, and risk level.

```bash
scip-query change-surface auth.service.ts
# File: src/services/auth.service.ts
# Test coverage: 60% | External consumers: 45
#
#   1-50   AuthService  [12 consumers] (2 test files) * medium risk *
#   5-20   login()      [8 consumers]  (1 test file)
#   22-35  logout()     [3 consumers]  (no tests) *** HIGH RISK ***
```

**Value:** One command before modifying any file. Shows what's exported, who uses it, what's tested, and what's dangerous.

---

#### `diff-impact`

Compute affected symbols from the current git diff.

```bash
scip-query diff-impact
scip-query diff-impact --base main
# Changed files: 3
# Changed symbols: 12
# Affected consumer files: 28
# Test coverage: 67%
```

**Options:**
- `--base <ref>` — Git ref to diff against (default: HEAD)

**Value:** Run before committing. Shows everything your changes affect, which consumer files are impacted, and where test gaps exist.

---

### De-bloating

#### `drift [module]`

Detect files that deviate from their directory's typical dependency pattern.

```bash
scip-query drift --min-deviation 30
# src/services/legacy-auth.ts  (65% deviation from src/services)
#   Missing expected: validator.ts, logger.ts
#   Unexpected:       raw-sql.ts, deprecated-crypto.ts
```

**Options:**
- `--min-deviation <n>` — Minimum deviation % to report (default: 30)

**Value:** Finds files that don't follow their neighbors' conventions. The outliers are either legacy code needing migration or intentional exceptions needing documentation.

---

#### `wrapper-candidates`

Find symbols only called by one consumer — potential premature abstractions.

```bash
scip-query wrapper-candidates --max-loc 15
#   src/utils/format.ts:10-18  formatCurrency  (8 LOC)
#     Only called by: formatInvoice  (fan-in: 12)
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--max-loc <n>` — Maximum LOC (default: 15)
- `-n, --limit <n>` — Number of results (default: 30)

**Value:** If a function is only called by one other function, it might be inlineable. The smaller it is, the stronger the signal.

---

#### `passthrough-candidates`

Find functions that forward to exactly one callee — pure indirection.

```bash
scip-query passthrough-candidates
#   src/services/user.ts:5-10  getUser  (5 LOC)
#     Forwards to: userRepo.findById  (src/repos/user.repo.ts)
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--max-loc <n>` — Maximum LOC (default: 15)
- `-n, --limit <n>` — Number of results (default: 30)

**Value:** Functions that just call one other function without adding logic. Either inline them or verify they serve a purpose (testing boundary, dependency inversion).

---

#### `stale-abstractions`

Find types, interfaces, and classes with 0-1 cross-file consumers.

```bash
scip-query stale-abstractions --min-loc 5
#   src/types/deprecated.ts:1-25  OldUserType  (25 LOC, unused)
#   src/interfaces/single.ts:1-15  ISingleUse  (15 LOC, 1 consumer)
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--min-loc <n>` — Minimum LOC (default: 3)
- `-n, --limit <n>` — Number of results (default: 30)

**Value:** An interface with one implementation isn't an abstraction — it's indirection. Finds over-engineering.

---

#### `complexity-hotspots`

Composite complexity score per symbol: LOC x fan-in x fan-out.

```bash
scip-query complexity-hotspots -n 10
#   score   LOC  fan-in  fan-out  callees  symbol
#   ─────  ────  ──────  ───────  ───────  ──────
#   101.7   541      47        0       16  types
#    31.3   279      28        5       33  symbol-parser
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--min-loc <n>` — Minimum LOC (default: 10)
- `-n, --limit <n>` — Number of results (default: 20)

**Value:** The symbols most likely to contain bugs and be hardest to modify. High score = high LOC + many consumers + many dependencies.

---

### Composite Reports

#### `health`

Single command that runs all analyses and produces a prioritized action list with a health score.

```bash
scip-query health
# Codebase Health Score: 72/100
# 54 files | 1501 symbols | 900 KB
#
# Findings:
#   Dead code:          12 symbols (340 LOC)
#   Similar pairs:      8
#   Stale abstractions: 5
#
# Prioritized Actions:
#   1. [low effort / high impact] 12 symbols with zero references — safe to delete (~340 LOC)
#   2. [low effort / medium impact] 5 types with 0-1 consumers — premature abstraction
#   3. [medium effort / medium impact] 8 pairs with >60% callee overlap — consolidation candidates

scip-query health --json    # JSON output for programmatic use
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--json` — Output as JSON

**Value:** The one command to rule them all. Runs every cleanup analysis, scores the codebase, and tells you exactly what to fix and in what order.

---

#### `convergence <symbol1> <symbol2>`

Given two similar functions (from `similar`), show what a consolidated version would look like.

```bash
scip-query convergence bottlenecks hotspots
# 82% callee overlap
#
#   A: bottlenecks  (src/queries/bottlenecks.ts, 68 LOC)
#   B: hotspots     (src/queries/hotspots.ts, 54 LOC)
#
#   Shared callees (9): ScipDatabase, db.all(), db.isIgnored(), ...
#   Unique to A (1): BottleneckResult
#   Unique to B (1): HotspotResult
#
#   Strategy: Create a shared function with the 9 common callees.
#   Pass the 2 divergent callees as parameters or strategy callbacks.
```

**Value:** Turns "these two functions are similar" into a concrete refactoring prescription.

---

### Source & Analysis

#### `code <symbol>`

Read the source code for a symbol, bounded to its definition range.

```bash
scip-query code shortenSymbol
scip-query code shortenSymbol -C 5    # 5 extra lines of context
```

**Options:**
- `-C, --context <n>` — Extra lines above/below the definition (default: 0)

**Value:** Read source without leaving the terminal. Language-agnostic — just reads the file at the line range from the index.

---

#### `complexity <symbol>`

Per-symbol complexity analysis: source-level branch counting + index-level metrics.

```bash
scip-query complexity login
#   LOC:                  41
#   Branches:             8
#   Cyclomatic estimate:  9
#   Callees:              5
#   Fan-in:               12
#   Fan-out:              3
```

**Value:** Combines source-level analysis (branch counting via language-aware regex) with graph-level metrics (fan-in, fan-out, callee count) for a complete complexity picture.

---

#### `dataflow <symbol>`

Reference-level dataflow: where data around a symbol comes from and where it goes.

```bash
scip-query dataflow login
#   ═══ DEFINED AT ═══
#     src/auth.service.ts:5
#   ═══ USED AT ═══
#     src/auth.controller.ts:15  in handleAuth
#   ═══ PRODUCERS (feeds into this) ═══
#     validateInput, formatName
#   ═══ CONSUMERS (this feeds into) ═══
#     sendEmail, logAudit
```

**Value:** Shows the data flow context: what other symbols are referenced alongside this one, what feeds in, what consumes it.

---

#### `slice <symbol>`

Reference-level program slicing: what affects a symbol (backward) or what it affects (forward).

```bash
scip-query slice login               # backward: what feeds in
scip-query slice login --forward     # forward: what this feeds into
```

**Options:**
- `--forward` — Forward slice instead of backward (default: backward)

**Value:** Backward slice shows inputs/dependencies. Forward slice shows outputs/effects. Useful for tracing data flow through error handling and concurrency paths.

---

### Additional Cleanup

#### `redundant-reexports`

Find barrel file re-exports that nobody imports through.

```bash
scip-query redundant-reexports
#   src/index.ts
#     resolveCacheDir()  (from src/config.ts)
#       barrel: 0 consumer(s) | direct: 0 consumer(s)
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `-n, --limit <n>` — Number of results (default: 30)

**Value:** Finds dead entries in barrel files. Note: TypeScript namespace imports (`import * as`) resolve through barrels transparently, so the command is most effective on codebases using named imports.

---

#### `similar-signatures`

Find functions with near-identical type signatures (same parameter types and return type).

```bash
scip-query similar-signatures --min-loc 5
#   Signature: (email: string): Promise<Token>  (2 functions)
#     src/auth.ts:5-20   login   (15 LOC)
#     src/auth.ts:22-37  signup  (15 LOC)
```

**Options:**
- `-s, --scope <path>` — Limit to files matching path
- `--min-loc <n>` — Minimum LOC per function (default: 3)
- `-n, --limit <n>` — Number of groups (default: 20)

**Value:** Different signal from callee similarity — catches "same interface, different implementation" even when the internal logic differs completely.

---

## Programmatic API

All 50 commands are available as TypeScript functions:

```typescript
import {
  ScipDatabase, createGitignoreFilter,
  health, affected, changeSurface, diffImpact,
  hotspots, similar, dead, convergence,
} from 'scip-query';

const filter = createGitignoreFilter('/path/to/project');
const db = new ScipDatabase({
  dbPath: '/path/to/index.db',
  indexPath: '/path/to/index.scip',
  projectRoot: '/path/to/project',
}, filter);

// Full health report
const report = health(db);
console.log(`Score: ${report.score}/100`);
console.log(`Actions: ${report.actions.length}`);

// Impact analysis
const blast = affected(db, 'login', { maxDepth: 3 });
const brief = changeSurface(db, 'auth.service.ts');
const impact = diffImpact(db, { base: 'main' });

// Consolidation
const pairs = similar(db, 'myFunction', { minSimilarity: 0.5 });
const recipe = convergence(db, 'funcA', 'funcB');

db.close();
```

## License

Apache-2.0
