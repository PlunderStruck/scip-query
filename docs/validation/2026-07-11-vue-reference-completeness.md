# Vue Reference Completeness Certification

Date: 2026-07-11

Verdict: **qualified for exact cross-file Vue component identities; general
Vue binding completeness remains unsupported**.

## Capability under review

A Vue augmented reference is a source occurrence that Volar resolves to a
specific definition and that scip-query can represent with an exact symbol in
its SQLite graph. Its essential distinction from a text match is identity:
the source token and persisted symbol must denote the same project definition.

The certified narrow capability is cross-file Vue component identity. For a
default component import, the local import name, component tag sites, resolved
`.vue` file, and synthetic default-export symbol must agree. Local template
bindings and JavaScript properties without exact base-index symbols are not
silently collapsed onto a containing component or function.

## Pinned replay

Each repository ran in an isolated detached worktree with a separate cache and
dependency-ready Vue/Volar project:

| Repository | Commit | Vue files | Inserted exact mentions | Direct relative-import relationships | Exact-oracle mentions |
| --- | --- | ---: | ---: | ---: | ---: |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` | 410 | 1,566 | 250 | 582 |
| on_main_mvp | `5faef0ffd5d17f9dc8058622a3f70005fd3232a6` | 86 | 245 | 104 | 245 |
| agent_chat | `a86e71fc083a8e6b505186283fb8dc9fb83e708d` | 9 | 14 | 7 | 14 |

The `agent_chat` worktree used an audit-only `allowJs` tsconfig because its
pinned commit had no project file. Its installed application dependencies and
the already pinned Volar runtime were linked into the temporary worktree; no
source repository was modified.

The independent oracle parsed default relative `.vue` imports, removed comment
and module-path text, counted the import binding plus actual component tag and
type-reference sites, and compared those sites to persisted SQLite symbols.
All 841 oracle mentions matched. In on_main_mvp, the one non-tag occurrence was
the valid `InstanceType<typeof BusinessSidebar>` reference. The result also
publishes source-stratified resolved samples with source token, coordinates,
definition file, and definition symbol.

The machine-readable verdict is
[`2026-07-11-vue-reference-completeness-verdict.json`](./2026-07-11-vue-reference-completeness-verdict.json).

## Defects found and hardened

The earlier 66,396 and 13,700 totals were not credible exact-symbol counts.
Three mechanisms inflated or misattributed them:

1. Every definition inside an SFC, including unrelated local state and loop
   variables, was mapped to that file's synthetic default-export symbol.
2. A JavaScript property with no indexed definition could inherit a nearby
   enclosing function's symbol. Real samples mapped `mode` and `agents` to a
   `load` function.
3. Identifier-looking pieces of import strings, such as a component filename,
   were inserted in addition to the actual import binding.

The resolver now inserts same-file-independent graph facts only. SFC targets
must be cross-file component names matching the resolved component filename;
non-Vue targets must match the exact indexed definition name. Module-path
fragments are excluded. Focused regressions preserve all three boundaries.

The result contract now discloses bounded, source-stratified resolved and
omitted samples. Omitted tokens are counted by `no-definition`,
`same-file-definition`, `unindexed-definition`, `missing-source-file`, and
`missing-service-script`. The CLI calls them not-inserted identifier tokens
rather than falsely describing each lexical token as a
missed reference.

## Applicability and remaining boundary

The command is available only when the selected Vue project and its
TypeScript/Volar dependencies load successfully. A missing project or provider
is an explicit failure, never a clean zero. Ordinary `reindex` still does not
run this optional augmentation automatically.

The overall verdict is qualified rather than certified because the base index
does not catalog every SFC-local binding or every property definition. Those
sites are now withheld and disclosed instead of being assigned a plausible but
wrong symbol. Cross-file Vue component identity is exact on the three pinned
cohorts; broader Vue semantic identity requires a richer definition catalog.
