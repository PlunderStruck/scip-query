# Source coverage and dead-code audit

Initial audit of `c0913db8` on 2026-09-07, following the completed complexity cleanup. Findings and definition locations below describe that commit. The subsequent authorized removal and its validation are recorded at the end; the public API is preserved.

## Complexity coverage

The current project inventory contains 3,110 files. The source health scan analyzed all 563 eligible TS/JS files and 13,591 functions, with accounted coverage, no problems and no findings. Its unchanged complexity limits are cyclomatic 10 and cognitive 15.

The 563 files comprise:

- All 513 TypeScript files in `src/`.
- All 46 TS/JS files in `scripts/`.
- Three root configuration files and one skill script.

The scan excludes 422 TS/JS test, fixture and benchmark files by default. Another 2,125 inventory entries have unsupported extensions; most are documents or data, not executable source. The two production source files in that latter group are `crates/scip-query-kernels/src/lib.rs` and `crates/scip-query-kernels/src/main.rs`. Rust complexity is not measured by this scanner. Files ignored by project inventory, managed output and third-party installation directories are outside this count.

Verified the live selection path in `src/source/maintenance-snapshot.ts` and `src/platform/project-files.ts`: current source comes from the project file inventory, applies explicit language/role exclusions, reports file/byte-limit omissions, and verifies source freshness. This is not a claim that every file on disk or every language has been evaluated.

## Dead-code assessment

`health --indexed --full` reports seven symbols with no visible repository references, totaling 78 lines. `dead --full --include-members --only-dead` reports ten candidates and 645 lines after adding three type fields. These are candidates for review, not automatic deletion instructions.

Checked exact source definitions, complete current-project text identities for all ten names, incoming execution/identity evidence, and the compiled declaration graph for all 66 public package entries. The text search covered 3,109 text files with no unreadable or oversized omissions; one archive was excluded as binary. The graph returned no incoming edges for the seven functions/methods, while explicitly disclosing reflection, generated dispatch and other unsupported relationships. It does not prove arbitrary dynamic invocation impossible.

### Five internal helper candidates

Each name occurs only at its declaration in current executable source. None appears in the public package export/declaration graph. Documentation and archived benchmark mentions are not callers. These five functions total 58 lines and are strong removal candidates, subject to deletion verification and the affected tests.

| Function                       | Current definition                                 | Lines |
| ------------------------------ | -------------------------------------------------- | ----: |
| `semanticCalleeCoverage`       | `src/semantic/shared-primitives.ts:851`            |    20 |
| `semanticCompilerProjectOf`    | `src/semantic/shared-primitives.ts:832`            |    13 |
| `repositoryTextInventory`      | `src/source/primitives/repository-text.ts:90`      |    12 |
| `budgetedGroupedByFileCommand` | `src/runtime/command-kit/command-execution.ts:275` |    10 |
| `isLengthDelimited`            | `src/reindex/scip-wire.ts:84`                      |     3 |

### Public methods incorrectly treated as deletion candidates

`ProjectIndex.scopedDefinitions` (`src/queries/internal/project-index.ts:25`, three lines) and `ProjectIndex.symbolsWithNonSelfCallees` (`src/queries/internal/project-index.ts:99`, 17 lines) have no repository callers, but belong to the `ProjectIndex` class exported from `src/index.ts:4`. Both methods are present in the package's public TypeScript declarations.

Their classification needs correction: absence of local callers does not establish that public library methods are unused by consumers. Removing either method would change the public API. Keep them unless an explicit compatibility decision authorizes removal.

### Type fields and incorrect line counts

The broader member scan reports these fields as spanning their entire files:

| Field                                  | Actual declaration                  | Reported lines | Assessment                                                                                                                  |
| -------------------------------------- | ----------------------------------- | -------------: | --------------------------------------------------------------------------------------------------------------------------- |
| `ScipQueryConfig.gitignorePaths`       | `src/domain/config-types.ts:118`    |            441 | Public configuration type field with no repository read found. Assess its advertised behavior and compatibility separately. |
| `LspLocationLink.originSelectionRange` | `src/semantic/rust/lsp-types.ts:20` |             82 | Optional field in a local protocol type; not a block of executable code.                                                    |
| `SyntaxNode.childCount`                | `src/source/ast/ast-types.ts:30`    |             44 | AST interface field also present in public declarations; not a block of executable code.                                    |

These three single-line declarations contribute 567 lines to the claimed recoverable total. The range and recoverable-line reporting are incorrect for these candidates and should be fixed before agents rely on the total for deletion planning.

### Rust check

`cargo check --manifest-path crates/scip-query-kernels/Cargo.toml --all-targets --locked --offline` passed with no warnings. No `dead_code` or `unused` lint allowances were found in the crate's current project text. This is a compiler check for the Rust targets, not a Rust complexity measurement or proof that all public Rust exports are used.

## Follow-up queue

- [x] Remove the five verified internal-helper candidates and their orphaned helper/imports; run affected tests, build/API checks and fresh dead-code analysis.
- [ ] Protect externally accessible public class methods in dead-code classification, with a fixture that exports a class whose public methods have no local callers.
- [ ] Correct member source ranges and recoverable-line totals; distinguish type declarations from executable implementations.
- [ ] Assess the unused public `gitignorePaths` declaration against the supported configuration contract.
- [ ] Add Rust complexity support before claiming complete complexity coverage of this repository's production languages.

## Authorized removal work

The user authorized removing the verified internal dead code. Remove only the five internal helpers listed above, plus imports or private declarations proven unused as a direct result. Preserve the public `ProjectIndex` methods, public type fields, and unrelated user files.

Before editing, run compiler-verified cleanup plans scoped to the four owning files and inspect their proposed deletions. Then apply the reviewed removals, run affected existing tests and source/contract type checks, build once checks are idle, verify the public API and consumer, run the full suite, and refresh the index/source-health/dead-code results. Record the actual outcome here and commit the focused change. Detector classification/range fixes and Rust complexity support remain separate follow-ups.

All four scoped cleanup plans passed isolated verification with zero baseline checker errors, no uncovered files and no dirty-source overlap. The five removals also leave `typescriptProjectFileNames` (`src/semantic/typescript/ts-morph-runtime.ts:186`, seven lines) without a caller. A complete repository text search found only its declaration and the removed helper's import/call. That directly orphaned helper is included in the removal, bringing the implementation total to six functions across five files. The shared semantic module's now-unused type and runtime imports are removed too. `RepositoryTextInventory` is still referenced by the live `RepositoryTextScanResult` type, so it is retained.

The indexed specialist report also contains similarity and drift candidates; this audit does not adjudicate those unrelated candidates. The earlier zero-finding result applies to current-source health and its documented checks, not to every specialist detector.

## Evidence artifacts

- `/tmp/complexity-final-health.json`: final source health result.
- `/tmp/scip-query-coverage-file-inventory.json`: complete current project file inventory.
- `/tmp/scip-query-dead-code-audit-health.json`: full indexed specialist report and capability disclosure.
- `/tmp/scip-query-dead-code-audit.json`: full dead-code result including members.
- `/tmp/scip-query-dead-candidate-search.json`: complete match identities for the ten candidate names.
- `/tmp/scip-query-dead-candidate-evidence.json`: incoming execution/identity projection with coverage limits.
- `/tmp/scip-query-dead-public-api-check.json`: public exports and declaration graph checks.
- `/tmp/scip-query-dead-rust-check.log`: successful Rust compiler check.

## Removal completed and verified

Removed the five audited internal helpers and the now-orphaned `typescriptProjectFileNames`: six function definitions across five source files, 65 lines in function definitions and 94 deleted source lines including comments, imports and spacing. No other implementation bodies were changed. Public `ProjectIndex` methods and the three type fields are retained. All five source diffs were reviewed.

The four scoped `cleanup-plan --full --verify` runs verified their proposed batches in isolated copies with zero baseline errors, no uncovered files and no dirty-source overlap. Subsequent source and contract type checks, changed-file ESLint/formatting, build, public consumer compilation and skill links passed. The public TypeScript API remains `b74137d6c422ca9c` across 66 paths, including after the orphaned helper's removal. Source and skill focused runs cover 142 distinct tests in 14 files (133 source-focused tests plus 52 skill/setup tests, with 43 overlapping CLI tests).

The final frozen full suite passed **3,267 tests in 368 files**, exit 0, with no unhandled errors. Source and skill hashes still match the frozen files.

Fresh reindex and source health cover **563/563 eligible files and 13,581 functions with zero findings**. Fresh full dead-code analysis including members reports exactly the five previously assessed public-method/type-field candidates; none of the six removed helpers remains and no additional internal deletion candidate appeared. This retains the detector's disclosed coverage limits and does not treat the five known unsuitable candidates as removable code.

`diff-impact --base c0913db8` reports five changed indexed files and zero changed current symbols/affected files, with two absent/excluded paths disclosed. The current-source review separately records the removed definitions and reports no findings; deletion verification and the public API check supply the relevant checks for these unreferenced helpers.

Evidence: `/tmp/scip-query-dead-removal-{semantic,text,commands,wire}-plan.json`, `/tmp/scip-query-dead-removal-{review,health,dead,impact}.json`, `/tmp/scip-query-dead-removal-*.log`, and `/tmp/scip-query-dead-removal-frozen-hashes.json`. The unrelated LaunchPoint benchmark document is preserved and excluded from the commit. Detector classification/range corrections and Rust complexity support remain on the follow-up queue.
