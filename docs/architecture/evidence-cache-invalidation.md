# Evidence Cache Invalidation

An evidence product is a stored analysis result for source code, index rows,
configuration, tool behavior, or git history; it is correct only while the
identity fields listed for that product still name the facts that produced it.

Invalidation is the miss rule for those stored results: when any identity field
changes, the old row must stop satisfying reads and the product must be rebuilt
from current evidence.

## Product Matrix

| Product | Referent | Table | Payload Owner | Key Parts | Invalidation Trigger | Staleness Test | Branch / Worktree / Clone / Workspace / Multi-Language |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `file:source-facts` | Parsed callable, call-site, identifier, and container facts for one source file. | `file_evidence` | `src/source/source-facts.ts` | kind, relative path, content hash, payload version | Source bytes or source-fact payload version change. | `tests/storage/evidence-cache.test.ts` | Safe when content hash changes; workspace and language changes matter only through the source bytes and parser behavior. |
| `file:file-definitions` | Definitions derived for one file and interpreted against the current project index. | `file_evidence` | `src/symbols/definition-catalog.ts` | kind, relative path, content hash, project fingerprint, payload version | Source bytes, project fingerprint, indexed languages, or payload version change. | `tests/storage/evidence-cache.test.ts` | Safe across branch/worktree/clone when project fingerprint and content hash match; workspace and language-set changes are covered by project fingerprint. |
| `file:definition-exclusions` | Framework and test-pattern exclusions for one source file. | `file_evidence` | `src/analysis/framework-patterns.ts` | kind, relative path, content hash, payload version | Source bytes or exclusion parser version change. | `tests/storage/evidence-cache.test.ts` | Safe when content hash matches; branch and workspace identity do not add facts beyond source bytes. |
| `file:doc-path-tokens` | Test-only typed file product used to verify product wrapper behavior. | `file_evidence` | `tests/storage/evidence-cache.test.ts` | kind, relative path, content hash, payload version | Source bytes or payload version change. | `tests/storage/evidence-products.test.ts` | Test-only product; not shared across real checkouts. |
| `file:doc-path-evidence` | Candidate code-path references found inside one documentation file. | `file_evidence` | `src/queries/cleanup/doc-drift.ts` | kind, relative path, content hash, tracked files, git history window, payload version | Doc bytes, tracked-file set, relevant git history, or payload version change. | `tests/storage/evidence-cache.test.ts` | Branch/worktree/clone safety depends on the git-history key; workspace changes matter when tracked path evidence changes. |
| `file:source-imports` | Parsed import edges for one source file plus import-resolution identity. | `file_evidence` | `src/language-parsers/index.ts` | kind, relative path, content hash, import-resolution fingerprint, payload version | Source bytes, import resolution config, or payload version change. | `tests/storage/evidence-cache.test.ts` | Safe across branch/worktree/clone when source and resolver identity match; workspace package edits are covered when resolver fingerprint changes. |
| `file:source-reexports` | Parsed re-export edges for one source file plus import-resolution identity. | `file_evidence` | `src/language-parsers/index.ts` | kind, relative path, content hash, import-resolution fingerprint, payload version | Source bytes, import resolution config, or payload version change. | `tests/storage/evidence-cache.test.ts` | Same sharing rule as source imports. |
| `file:source-fingerprints` | Source-token fingerprints used by similarity analysis for definitions in one file. | `file_evidence` | `src/queries/cleanup/similar.ts` | kind, relative path, content hash, project fingerprint, payload version | Source bytes, project fingerprint, indexed languages, or payload version change. | `tests/symbols/definition-catalog.test.ts` | Safe when source and project identity match; workspace and multi-language changes are project-shaped. |
| `file:consumer-file-usage` | Imported and used leaf names for one consumer file. | `file_evidence` | `src/queries/internal/consumer-evidence.ts` | kind, relative path, content hash, project fingerprint, payload version | Source bytes, project fingerprint, indexed languages, or payload version change. | `tests/storage/evidence-cache.test.ts` | Safe when source and project identity match; workspace dependency changes must alter project identity when they affect usage evidence. |
| `file:react-component-behavior-profiles` | JSX and behavior-token profile for one React component file. | `file_evidence` | `src/source/react-profile.ts` | kind, relative path, content hash, payload version | Source bytes or React profile parser version change. | `tests/storage/evidence-cache.test.ts` | Safe when content hash matches; workspace identity is not otherwise part of the payload. |
| `file:git-file-adds` | File-first-added records derived from bounded git history. | `file_evidence` | `src/analysis/git-history.ts` | kind, cache key, HEAD, history window, payload version | Git HEAD/history window or payload version change. | `tests/storage/evidence-cache.test.ts` | Not safe across branch/worktree/clone unless HEAD and history key match exactly. |
| `project:file-dependency-graph` | Whole-project file dependency graph combining SCIP edges and source imports. | `project_evidence` | `src/symbols/graph/file-dep-graph.ts` | kind, scope, project fingerprint, source-import fingerprint, payload version | Project fingerprint, source-import fingerprint, indexed language set, or payload version change. | `tests/symbols/file-dep-graph.test.ts` | Safe across branch/worktree/clone when project and import fingerprints match; workspace and multi-language changes are included through those fingerprints. |

## Benchmark Commands

- `node scripts/performance-architecture-contract.mjs --repo . --command "health --json" --warm-iterations 1 --no-clear`
- `node scripts/profile-scoreboard.mjs --input <profile-jsonl> --top 10 --json`
- `node scripts/check-evidence-manifest-doc.mjs`
