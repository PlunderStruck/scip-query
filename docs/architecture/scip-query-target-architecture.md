# scip-query architecture

This is the current ownership guide. [`.scipquery.json`](../../.scipquery.json)
is the executable file membership and dependency policy. The
[September audit](../plans/2026-09-07-architecture-audit.md) and
[fix record](../plans/2026-09-07-architecture-fixes.md) explain the latest changes.
The [previous guide](history/2026-09-07-target-architecture.md) preserves historical
migrations and measurements; use this guide and the current reports for new work.

## How to read the structure

An ownership boundary is a named group of source files responsible for one kind
of decision. For example, the storage files decide how records are retained and
published; query files decide which evidence answers a request. Files belong
together because callers can rely on that decision being made in one place.
A directory is evidence about organization, but its name alone does not establish
ownership.

A dependency is a source relationship in which one file imports or re-exports
another file's definitions. In the policy, `A -> B` permits files owned by `A` to
use definitions owned by `B`. Each boundary has a closed outgoing row: targets
absent from that row are forbidden. A dependency cycle is a chain of these
relationships that returns to its starting owner, making the participants rely
on one another to change or initialize.

An interface is the set of operations and values a caller must understand to use
an owner. A useful interface hides decisions that callers should not repeat.
Export counts and argument counts can locate candidates for review; they cannot
establish that the interface hides the right decisions. Judge that by tracing an
actual feature and the changes its callers must make.

## Main owners

| Owner | Decision it owns |
| --- | --- |
| `domain` | Shared identities, value shapes, validation rules and project-input transitions, without host operations |
| `filesystem` | Bounded descriptor reads and durable low-level file operations |
| `instrumentation` | Profiling observations |
| `platform` | Host process identity, tool discovery, project-file observation, cache layout and locks |
| `storage` | SQLite access, retained generations, durable records, mailbox storage and cache lifetimes |
| `source` | Current-text and syntax facts, including the language parser strategies |
| `symbols-core`, `symbols-references`, `symbols-graph` | Repository symbol identity, references, and indexed dependency/call relationships |
| `semantic-contracts` | Provider-independent semantic request and result contracts |
| `semantic-core`, `semantic-typescript`, `semantic-rust` | Provider selection and compiler-backed evidence |
| `analysis` | Shared interpretation of repository evidence |
| `queries-*` | Exploration, graph, health, impact and other query products; the exact subdivisions are in the policy |
| `reindex`, `reindex-augmentation`, `reindex-vue` | Affected-work selection, index construction and publication, and source augmentation |
| `public-api` | Published library exports |
| `runtime-entry`, `runtime-commands`, `runtime-query-commands`, `runtime-command-kit` | Command composition, registration and delivery adapters |

The policy also covers shipped tooling, native packages, explicitly selected
shared test fixtures, and `property-verification` for the generated state and
input checks under `tests/properties`. That test harness may exercise source,
storage, indexing, query and runtime protocols; production owners cannot import it. The inventory command below lists every configured group
and its coverage. The table explains the principal responsibilities rather than
duplicating the complete dependency matrix.

`source` includes both `src/source` and `src/language-parsers`: they produce syntax
facts together. Semantic providers supply compiler binding and type evidence, a
different guarantee. Preserve that distinction when choosing an existing parser
or provider. Symbol code receives the optional semantic operations it needs
through a symbols-owned capability contract implemented by the semantic layer;
it does not import provider orchestration.

Storage may use platform process identity and locking to retain the exact
immutable database backing a reader. Platform does not choose query workflows.
Reindex uses storage publication operations; it does not implement a second
filesystem publication protocol. Shared record decoders live in domain so
storage, reindex, semantic workers, and runtime can agree without importing one
another's workflows.

## Runtime responsibilities

The top-level runtime files have exact membership in these groups. They remain
in their existing locations; enforcement follows the decisions they own.

| Owner | Responsibility | Permitted runtime dependencies |
| --- | --- | --- |
| `runtime-contracts` | Command roles, envelope shapes, cursor encoding and invocation defaults | None |
| `runtime-output` | Rendering, source emission and pagination | Contracts |
| `runtime-project` | Configuration, project context, revisioned updates and index freshness | None |
| `runtime-analysis` | Analysis preparation, readiness, capability reporting, receipts and analysis caches | Project, output |
| `runtime-watch-control` | Watch-service identity, start/stop control and pruning | None |
| `runtime-index-maintenance` | Refresh coordination, evidence freshness and repository cache collection | Analysis, project, watch control |
| `runtime-background` | Watch execution and compiler-worker coordination | Index maintenance, project, watch control |
| `runtime-query-service` | Query transport, server execution and fast CLI parsing | Analysis, contracts, output, project, watch control |
| `runtime-installation` | Installation, onboarding and removal | Analysis, contracts, project, watch control |

Each group also has explicitly permitted lower-level dependencies in the policy.
Command entrypoints compose these owners. Configuration and pure command
contracts cannot import servers. Query delivery cannot import installation.
These restrictions prevent an ordinary query from acquiring unrelated setup
behavior and keep configuration reusable outside a running service.

Each runtime group and the flat `reindex` group uses `subUnits: file`. This checks
cycles between files even when they share one directory. Other groups use their
configured directory subdivisions. A clean boundary graph therefore needs to be
read together with its internal-cycle coverage, rather than treated as proof
that every file graph is acyclic.

## Existing paths to extend

### Cached source evidence

A cache stores a previous result under an identity so later requests can reuse
it. Reuse is valid only while that identity still represents the same inputs.
[`per-db-cache.ts`](../../src/storage/per-db-cache.ts) owns bounded storage and
per-database isolation; the cache registry owns invalidation notifications.

Use `createPerDbFileCache` when the key is one repository-relative file path.
It normalizes separators and clears that file selectively. Use
`createPerDbCache` for arbitrary identities such as symbol or source-range keys;
a file notification conservatively clears that database's cache because a file
path cannot identify those entries. Use the existing source-aware factory when
reuse also requires comparing current source content. Local flow keeps its
bounded range cache and follows the conservative invalidation rule. Do not add
caller-specific parsing of opaque keys or a second invalidation registry.

### Incremental indexing and publication

Incremental indexing updates a retained index using the changed inputs and their
affected consumers. The manifest describes observed input changes;
[`affected-set.ts`](../../src/reindex/affected-set.ts) owns shared reasons that
require a whole-project update. The TypeScript materializer computes one decision
for both dependency-graph acquisition and emission. Its explicit refinements
preserve deletion closure, active configuration selection and semantic edit
filtering. New compiler source files require project replacement because they
can change how existing imports resolve. A replacement includes every current
compiler source document, including unchanged documents.

Publication produces an immutable generation: one retained database, metadata
and index artifact set with a shared identity. Storage readers retain that
identity for their lifetime. Reindex validates the candidate and current inputs
before publication, while the storage generation mechanism protects active
readers from collection. Extend these owners and the real compiler-history
checks; preserve failure recovery, old-reader retention and request identity
across worker handoffs.

### CLI query dispatch

The canonical command descriptors own the complete CLI grammar. The lightweight
fast parser accepts a tested subset and falls through to canonical dispatch for
unsupported forms. Its parser map alone selects eligible commands.
[`query-invocation-policy.ts`](../../src/runtime/query-invocation-policy.ts)
owns shared search/code defaults and exact integer parsing. CLI defaults remain
distinct from library defaults where the public contracts differ.

When changing a fast-supported option, update the existing parser and canonical
descriptor and extend the canonical-versus-fast contract tests. Keep query
implementations in their existing owners and preserve lightweight startup.

## Checking a change

Use the build from the current checkout when auditing changes to the tool:

```sh
node dist/cli.js system --source
node dist/cli.js system --source boundary:runtime-project
node dist/cli.js architecture
node dist/cli.js review --base HEAD
node dist/cli.js diff-impact --base HEAD
```

`system --source` inventories current TS/JS source, including groups without
findings; selecting an exact printed group gives its dependency evidence.
`architecture` checks the configured rules against indexed relationships and
reports test-boundary checks. Current TS/JS syntax supplements the indexed graph
through the same compiler-backed import extractor used by source scanning,
including literal dynamic imports, unshadowed CommonJS and import-type
expressions. Nonliteral or unresolved targets remain explicit coverage limits;
they prevent an unused-allowance claim for their owning boundary. Refresh the index with `reindex` when its source
identity is stale. Read coverage before interpreting a missing edge or claiming
that every file was checked. Current-source and compiler-indexed views have
different scopes, and computed imports may remain unresolved.

The policy requires complete ownership and outgoing rows, forbids boundary
cycles, checks configured internal subdivisions, and rejects unused allowances.
A new dependency needs a reason grounded in the owning operation and its actual
consumers. Do not add allowances, raise limits, or suppress findings just to make
a report clean. Tests under mirrored unit-test paths inherit the corresponding
production owner's restrictions; cross-owner publication/pagination checks live
in integration tests and share fixtures without widening production policy.

A clean report establishes the checks it names within its coverage. It does not
score design quality or prove that a feature has one complete implementation.
For that judgment, trace the existing entrypoint, reused operations, durable
changes and returned result, then inspect which decisions callers still repeat.
