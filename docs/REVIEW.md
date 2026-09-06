# Explore, plan, review

Use `scip-query health` for an initial scan and `scip-query review --base HEAD` after changing code. Both read current TypeScript/JavaScript files without a compiler index. `context <symbol>`, exact source reads, and explicitly selected relationship evidence support planning around existing implementations. The installed scip-query skill connects these operations to a written plan and behavioral checks.

A finding is a report identifying concrete source and evidence of a possible defect or maintenance problem. Derived findings report a deterministic calculation, such as a circular import component. Candidates identify code requiring judgment, such as similar implementations whose contracts may differ. Neither category establishes that an automatic rewrite is correct.

## Normal use

```sh
scip-query health
scip-query context <existing-symbol>
# Write a plan citing the implementation, consumers, preserved behavior, and checks.
# Implement and run the relevant tests.
scip-query review --base HEAD
```

`review` compares the named commit with current files, including untracked files, unstaged edits and staged changes still present in current bytes. It lists added, modified and removed functions, including callbacks. Changed functions below warning thresholds still appear. Unique path/name pairs receive before/after metrics; ambiguous names receive uncomparable records. Renames and splits are not guessed: they may appear as removal plus addition. This is not a staged-only report.

Findings are classified as introduced, worsened, existing, resolved, or uncomparable. Duplicate comparisons scan repository peers, including same-file peers and functions added to old files; they do not use file creation dates to decide whether a copy is new. `--scope src/module` filters displayed subjects while retaining repository peers for comparison. `--include-tests` includes tests, fixtures and benchmarks. `--full` displays all findings; it does not remove source-analysis bounds. `--max-files` raises the default 10,000-file limit. Files over 1 MiB and snapshots over 128 MiB are disclosed omissions.

`--check` exits 1 for introduced/worsened derived review findings (or any derived health finding), 2 for incomplete source coverage or unavailable explicitly requested test coverage, and 0 otherwise. Similarity candidates do not fail this gate. A zero exit code does not establish behavioral correctness, complete dependency coverage, or good ownership. Coverage limitations apply even when the source scan is accounted for.

`health --indexed` retains specialist framework, drift and cleanup analyses. `health --baseline` and `--write-baseline` retain the indexed finding-identity baseline. Fresh `diff-impact` and `evidence` establish indexed symbol consumers and supported runtime relationships. The current-source report's affected files are transitive importers only.

## Complexity rules

A function is an executable source unit with parameters and an implementation body. Each function, method, accessor, constructor and callback is measured separately; a nested function's decisions are not added to its enclosing function.

Cyclomatic complexity is a control-flow measure counting independent decision paths under a specified counting rule. Rule set `typescript-function-local-v1` starts at 1 and adds 1 for each `if`, loop, non-default `case`, `catch`, ternary, and `&&`, `||`, or `??` operation. It does not attempt interprocedural path feasibility or implicit exception paths.

Cognitive complexity is a structural measure that increases when control-flow interruptions occur inside other control-flow structures. This implementation adds 1 plus nesting for `if`, loops, `catch`, ternaries and `switch`; `else` and `else if` add 1; same-operator logical sequences add 1; labeled jumps add 1. Nullish coalescing adds no cognitive increment. Contributions include exact line/column locations in the machine result. The initial warning thresholds are cyclomatic >10 or cognitive >15; they are review defaults, not universal design laws.

The structural rules are informed by [SonarSource's specification](https://www.sonarsource.com/docs/CognitiveComplexity.pdf). This version does **not** claim exact Sonar parity: it measures nested functions independently and omits recursion because source spelling alone cannot establish recursive binding. Metrics identify branching and nesting; they do not measure whether a business concept has a clear owner.

## Actual coverage and CRAP

Test coverage is a record of which executable source locations were observed during a test run. CRAP is a numerical review measure combining cyclomatic complexity with uncovered execution locations:

`CRAP = complexity² × (1 − coverageFraction)³ + complexity`.

This is the continuous formula used in [php-code-coverage's CRAP implementation](https://github.com/sebastianbergmann/php-code-coverage/blob/main/src/Node/CrapIndex.php), without its ≥95% shortcut. Here the coverage fraction counts distinct Istanbul statement-start lines belonging to the function, excluding nested function statements. It is not branch coverage, path coverage, or proof that assertions checked the behavior. CRAP ≥30 produces a review finding. Base CRAP is unavailable without an independent source-matched base measurement, so current CRAP findings are uncomparable rather than falsely introduced.

Configure your existing test runner to write Istanbul `coverage-final.json`. Then wrap that actual command. For a local package installation:

```sh
node node_modules/scip-query/scripts/record-review-coverage.mjs \
  --input coverage/coverage-final.json --output .scipquery/coverage.json \
  -- npm test -- --coverage
scip-query review --coverage .scipquery/coverage.json
```

Use the test arguments appropriate to your project; the recorder does not install a coverage provider. In this repository the script is at `scripts/record-review-coverage.mjs`. It requires Git, a successful test process, a fresh coverage artifact and unchanged source hashes before/after the run. The receipt contains `schemaVersion: 1` and a `files` object keyed by project-relative path; each entry holds `sourceHash` (SHA-256 of file bytes) and its original Istanbul `coverage` entry. Missing hashes, changed bytes, malformed coverage or unmapped executable locations yield **unavailable**, never fabricated zero coverage. Both health and review print available/unavailable measurement counts. Supplying unusable coverage makes the report incomplete; review requires coverage for its changed current functions, while health requires it for functions in its displayed scope. Keep receipts local; regenerate after edits.

## What findings establish

`suppress <id>` records an exception supported by named source, configuration, test or graph evidence. Automatic acceptance requires a content hash for every file named by the finding, even when the reason is supported by a different file. Supply repeated `--evidence source:<target-file>` arguments alongside that other evidence. Changing or deleting a target or cited evidence invalidates the exception; missing target evidence leaves the finding open. Raw findings remain visible in the report. Suppression checks establish that the reviewed referents still match, not that the written justification is correct.

Duplicate findings compare entire function bodies with at least 60 tokens. They preserve literal values and property names, ignore comments and formatting, and disclose local-binding renaming as candidate evidence. A compiler binding lookup distinguishes each local declaration from unrelated globals and shadowed variables; no import resolution or project-wide typecheck is implied. This is neither semantic equivalence nor partial-block clone detection. Compare callers, errors, side effects, state and intended contracts before selecting one implementation to own a rule. Similar code can correctly serve separate responsibilities.

Dependencies use TypeScript compiler resolution over captured repository source and configuration: relative imports, `paths`/`baseUrl`, JSONC inheritance, project references and repository package exports. Each Git revision uses its own configuration. Missing external configuration is disclosed; the compiler host never silently reads current filesystem bytes to resolve the base. External packages and Node built-ins are counted separately from missing or ambiguous internal imports. Existing relative asset targets (for example CSS) are recorded as excluded dependencies, not missing executable modules. Runtime package installation, custom loaders and nonliteral dynamic targets remain outside this source provider.

The production file-cycle report uses static value imports and re-exports. Type-only imports, tests, dynamic imports and CommonJS calls have separate counts and exact import records. Declared architecture checks include type dependencies and exclude test-related edges; the indexed command preserves dedicated opt-in test-policy checks. Boundary cycles explicitly report whether a cycle between files exists or only the grouping creates the cycle. Neither proves a runtime initialization failure. Missing dependency-policy rows remain unknown directions, even when every analyzed file has a boundary. First-use source checks report observed forbidden edges, enforced group cycles, configured bounds and assignment violations; use `architecture` for the full indexed policy, including test policy and unused allowances.

Review lists source changes, configuration changes and import-relationship changes separately. Configuration-only edits can affect unchanged consumers without inventing added or modified functions. Configuration gaps make dependency comparisons uncertain while exact source metrics remain comparable. Removed targets remain visible through both source revisions.

Default exclusions cover tests (including end-to-end test support), fixtures, benchmarks, declarations, managed build output, generated directories, and reference/vendor copies. `--include-tests`, `--include-generated` and `--include-references` opt into those source roles. Exclusion reasons, eligible/analyzed file counts, missing dependencies and parse/resource failures are visible. Project configuration selects the applicable resolution rules; compiler `include`/`exclude` membership does not silently erase repository tooling from the source inventory.

Health presents dependency components separately from five module planning subjects by default. A shared cycle is not assigned to its first member as that module's defect. A subject groups findings by an unambiguous declared boundary, or by directory when none exists; it is not a discovered business responsibility. Each subject includes exact implementations, observed consumer/dependency files and ranked findings. The first display gives the strongest available example of each finding kind a slot before filling remaining slots, so many copies cannot crowd out all complexity evidence. `--limit` changes the displayed subject count; `--scope` focuses a source path; `--full` returns all findings and details. Machine reports preserve all subjects and findings using `--json --json-output <path>`.

A responsibility candidate requires at least two independent groups of substantial exported top-level functions (at least two functions with 60 body tokens per group), separate observed dependencies and separate named importers. Same-file helpers/state and shared imported modules connect groups; orchestration and shared consumers are contrary evidence. The provider follows lexical binding identity, including nested closures, rather than matching identifier spelling. Classes, indirect re-exports, dynamic consumers, external users and runtime resource identity remain unestablished. A common public contract can justify retaining separate operations together; candidates never authorize an automatic split.

Ownership and conceptual cohesion still require combining behavior, consumers and dependency evidence. The tool does not invent owners, declare a large module inherently wrong, or assign an architectural grade. Plans should record established responsibilities, uncertain alternatives, existing patterns to reuse, and the tests that would catch a mistaken consolidation.

## Retirements

`twin-ab` and its public API were removed: the command generated an unfinished test scaffold, not a behavioral comparison. Write and run focused comparison tests in the project's own test suite. `code file:start-end` now reads only that range by default; add `--local-calls` for statically attributed same-file callees. Default `health` now returns concrete current-source findings; existing consumers of the specialist JSON report should use `health --indexed`.
