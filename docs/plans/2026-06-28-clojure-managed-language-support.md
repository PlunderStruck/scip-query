# Clojure Managed Language Support Plan

Date: 2026-06-28

## Goal

Make Clojure a first-class managed language in scip-query.

A first-class managed language is a source language that scip-query can identify in a project, route to the right SCIP indexer, track for freshness, report in readiness and capability output, and include honestly in health and cleanup workflows. For Clojure, the real-world referents are Clojure and ClojureScript files such as `.clj`, `.cljs`, and `.cljc` in repositories like Logseq; the wider class is "languages indexed through SCIP"; the essential difference is that Clojure support is produced by `scip-clojure`, with `clj-kondo` supplying semantic Clojure analysis before scip-query consumes the resulting graph.

A SCIP graph is the persisted code-intelligence record that ties files, symbols, definitions, and references together so commands can answer navigation and impact questions without reparsing the whole project. `clj-kondo` is a Clojure static analyzer: it reads Clojure code without running the app and emits facts about namespaces, vars, definitions, usages, and aliases. A health score is scip-query's auditable summary of graph-backed risk, heuristic hygiene, and git-history pressure; for Clojure it should use the graph facts that `scip-clojure` produces and label any weaker source-fallback evidence plainly.

Done means:

- `scip-query reindex --language clojure --force` can run `scip-clojure` for Logseq.
- `status --capabilities`, `check-deps`, setup diagnostics, and capability matrix list Clojure.
- Core graph commands work against the Logseq Clojure index: `stats`, `code`, `refs`, `trace`, `outline`, `deps`, and `affected`.
- `health --json` returns in a bounded time on Logseq or reports an explicit large-index budget warning.
- Cleanup verification either uses `clj-kondo` for `.clj`, `.cljs`, and `.cljc`, or reports Clojure cleanup verification as unavailable.

## Current State

`SupportedLanguage` is the central language set and currently ends at `php`; it has no `clojure` member. Source: `scip-query plan-context SupportedLanguage --json`; `scip-query code SupportedLanguage -C 8` shows `src/domain/config-types.ts:16-31`.

Language detection runs through `detectLanguages()`, which builds root entries and extension sets, walks `LANGUAGE_MARKERS`, and returns detected languages. The detection result feeds reindex, init, freshness, and readiness. Source: `scip-query plan-context detectLanguages --json`; `scip-query code LANGUAGE_MARKERS -C 8` shows `src/reindex/detect.ts:38-46`; the plan context shows consumers in `src/reindex/index.ts`, `src/runtime/commands/command-handlers.ts`, `src/runtime/index-freshness.ts`, and `src/runtime/project-readiness.ts`.

Indexer dispatch runs through `INDEXER_CONFIGS` and `getIndexerConfig(language)`. `prepareIndexerRun()` resolves the indexer binary, auto-installs when configured, then calls `config.indexArgs({ projectRoot, outputPath, pnpmWorkspaces, indexerBinary, projectPath })`. Source: `scip-query plan-context getIndexerConfig --json`; `scip-query code INDEXER_CONFIGS -C 10` shows `src/reindex/indexers.ts:12-22`; `scip-query code prepareIndexerRun -C 12` shows `src/reindex/index.ts:547-606`.

`ReindexOptions` only carries TypeScript-specific indexer options today: `pnpmWorkspaces`, `typescriptProjectMode`, and `typescriptProjects`. Source: `scip-query code ReindexOptions -C 10` shows `src/reindex/index.ts:36-64`. The CLI handler passes only those TypeScript-specific config fields into `reindex()`. Source: `scip-query code handleReindex -C 12` shows `src/runtime/commands/command-handlers.ts:111-130`.

Freshness and per-language reuse depend on language-specific project-file fingerprints. Source: `scip-query code computeLanguageFingerprints -C 12` shows `src/reindex/index.ts:916-942`; `scip-query code LANGUAGE_SOURCE_EXTENSIONS -C 8` shows `src/reindex/project-files.ts:151-159`.

Capability reporting uses `getProjectReadiness()`, which detects/configures languages, checks each indexer through `getIndexerDependencyStatus(getIndexerConfig(language), projectRoot)`, checks TypeScript semantic status only when TypeScript is present, and maps project checkers through `detectCheckers()`. Source: `scip-query plan-context getProjectReadiness --json`; `scip-query code LANGUAGE_EXTENSIONS -C 8` shows `src/runtime/project-readiness.ts:65-73`; `scip-query code SOURCE_FACT_SUPPORT -C 8` shows `src/runtime/project-readiness.ts:83-91`.

Cleanup verification is already multi-language. `detectCheckers()` adds `tsc`, `go build`, Python, and Cargo checkers, each with `coversExtensions`. Source: `scip-query plan-context detectCheckers --json`; `scip-query code detectCheckers -C 8` shows `src/runtime/cleanup-verify.ts:140-176`.

Health runs all phases through `HEALTH_PHASES.map(...)`; normal health only uses the large-index scan limit after 75,000 symbols or 5,000 documents. Source: `scip-query plan-context health --json`; `scip-query code runHealthAnalyses -C 10` shows `src/queries/health/health.ts:319-327`; `scip-query code healthBudget -C 12` shows `src/queries/health/health.ts:609-636`.

Source scanning has a central extension list. Source: `scip-query code ALL_SOURCE_EXTENSIONS -C 8` shows `src/source/source-fileset.ts:34-42`.

## Reuse Audit

- Reuse existing language registries instead of creating a new Clojure registry. Sources: `scip-query plan-context SupportedLanguage --json`, `scip-query code LANGUAGE_MARKERS -C 8`, `scip-query code INDEXER_CONFIGS -C 10`, `scip-query code LANGUAGE_EXTENSIONS -C 8`, `scip-query code LANGUAGE_SOURCE_EXTENSIONS -C 8`.
- Reuse `prepareIndexerRun()` and `IndexerConfig.indexArgs()` for Clojure. Source: `scip-query code prepareIndexerRun -C 12` shows the binary resolution, install, env, and args path at `src/reindex/index.ts:560-606`.
- Reuse `detectCheckers()` and `coversExtensions` for Clojure cleanup verification rather than adding a separate verifier. Source: `scip-query code detectCheckers -C 8`.
- Reuse health's existing budget and phase model first; add only a bounded Logseq regression if the current thresholds still time out. Source: `scip-query code healthBudget -C 12`.
- `scip-query similar-files src/reindex/indexers.ts --json` returned no structurally similar file, so `INDEXER_CONFIGS` remains the canonical extension point.
- `scip-query similar prepareIndexerRun --json` found only low-similarity structural overlap with unrelated functions, so no new helper is justified for indexer prep.
- `scip-query similar-chains --json` showed shared runtime/config/domain chains, confirming this change should flow through the existing config and domain types instead of a parallel Clojure config path.

## Phase 1 - Language Catalog And Detection

### 1.1 - Add Clojure To The Supported Language Type

- [ ] **File**: `src/domain/config-types.ts:16-31`
- **Source**: `scip-query code SupportedLanguage -C 8`
- **What**: `SupportedLanguage` lists TypeScript, JavaScript, JVM, Rust, Python, Ruby, Go, C/C++, .NET, Dart, and PHP, but not Clojure.
- **Change**: Add `'clojure'` to the union.
- **Why**: Every downstream language map is keyed by `SupportedLanguage`; without this type member, Clojure cannot be added to indexer, readiness, freshness, or config maps.

### 1.2 - Add Clojure To Config Validation

- [ ] **File**: `src/runtime/config.ts:18-26`
- **Source**: `scip-query code SUPPORTED_LANGUAGES -C 8`; `scip-query code validateProjectConfig -C 12`
- **What**: `validateProjectConfig()` builds a set from `SUPPORTED_LANGUAGES` and rejects unknown `config.languages` entries at `src/runtime/config.ts:70-78`.
- **Change**: Add `'clojure'` to `SUPPORTED_LANGUAGES`.
- **Why**: `.scipquery.json` must be able to declare `"languages": ["clojure"]` for Logseq testing and for mixed repos that want explicit language selection.

### 1.3 - Detect Clojure Projects

- [ ] **File**: `src/reindex/detect.ts:38-46`
- **Source**: `scip-query plan-context detectLanguages --json`; `scip-query code LANGUAGE_MARKERS -C 8`
- **What**: `LANGUAGE_MARKERS` has markers for existing languages and `detectLanguages()` pushes a language when marker files, root globs, or extensions match.
- **Change**: Add a Clojure marker entry:

  ```ts
  {
    language: 'clojure',
    files: ['deps.edn', 'project.clj', 'bb.edn', 'shadow-cljs.edn'],
    extensions: ['.clj', '.cljs', '.cljc'],
  }
  ```

- **Why**: `.edn` alone is a data-file signal and should not be treated as a source extension, but Clojure project marker files plus `.clj/.cljs/.cljc` should opt a project into Clojure indexing.

### 1.4 - Track Clojure Source Files For Freshness

- [ ] **File**: `src/reindex/project-files.ts:151-159`
- **Source**: `scip-query code LANGUAGE_SOURCE_EXTENSIONS -C 8`; `scip-query code computeLanguageFingerprints -C 12`
- **What**: `computeLanguageFingerprints()` uses `fingerprintProjectFiles(projectRoot, { language, markerFiles })`; `LANGUAGE_SOURCE_EXTENSIONS` controls which language files affect the fingerprint.
- **Change**: Add `clojure: ['.clj', '.cljs', '.cljc']`.
- **Why**: `skipIfUnchanged` must rebuild the Clojure shard when Clojure source changes.

### 1.5 - Include Clojure In Source File Scanning

- [ ] **File**: `src/source/source-fileset.ts:34-42`
- **Source**: `scip-query code ALL_SOURCE_EXTENSIONS -C 8`
- **What**: `ALL_SOURCE_EXTENSIONS` lists every source extension scip-query scans outside the SCIP graph.
- **Change**: Add `.clj`, `.cljs`, and `.cljc`.
- **Why**: Source-backed commands should at least be able to read Clojure files when they appear in an indexed project, even before a Clojure source-fallback parser exists.

## Phase 2 - Indexer Integration And Config

### 2.1 - Add A Generic Config Path Override

- [ ] **File**: `src/domain/config-types.ts:184-191`
- **Source**: `scip-query code IndexerOverrides -C 12`; `scip-query code ProjectConfig -C 12`
- **What**: `IndexerOverrides` only has TypeScript-specific fields: `pnpmWorkspaces`, `projectMode`, and `projects`.
- **Change**: Add `configPath?: string` with documentation: "Indexer-specific config file path, relative to project root unless absolute."
- **Why**: Logseq needs to pass `-config` to `scip-clojure` so it can run `clj-kondo` over the right Clojure paths.

### 2.2 - Validate The Config Path Override

- [ ] **File**: `src/runtime/config.ts:102-140`
- **Source**: `scip-query code validateProjectConfig -C 12`
- **What**: validation currently checks TypeScript project mode and project paths, including path containment and existence warnings at `src/runtime/config.ts:114-132`.
- **Change**: Validate `config.indexer?.clojure?.configPath` if present:
  - must be a non-empty string;
  - when `opts.projectRoot` is present, must resolve inside the project root;
  - warn, not error, if the file does not exist.
- **Why**: Project config is a trust boundary. A config path must not escape the project root or silently accept an unusable value.

### 2.3 - Pass Clojure Config Into Reindex

- [ ] **File**: `src/reindex/index.ts:36-64`
- **Source**: `scip-query code ReindexOptions -C 10`
- **What**: `ReindexOptions` has TypeScript-specific options but no per-language config path.
- **Change**: Add `clojureConfigPath?: string`.
- **Why**: `handleReindex()` needs to pass `.scipquery.json` Clojure override data into the reindex pipeline.

### 2.4 - Thread The Config Path To `indexArgs`

- [ ] **File**: `src/domain/config-types.ts:46-52`
- **Source**: `scip-query code IndexerConfig -C 10`
- **What**: `IndexerConfig.indexArgs()` receives `projectRoot`, `outputPath`, `pnpmWorkspaces`, `indexerBinary`, and `projectPath`.
- **Change**: Add `configPath?: string` to the `indexArgs` option object.
- **Why**: Indexer-specific config belongs in the existing `indexArgs()` contract, where each language already translates scip-query options into process arguments.

### 2.5 - Thread The Config Path Through Indexer Preparation

- [ ] **File**: `src/reindex/index.ts:466-590`
- **Source**: `scip-query code prepareIndexerRuns -C 12`; `scip-query code prepareIndexerRunsForLanguage -C 12`; `scip-query code prepareIndexerRun -C 12`
- **What**: `prepareIndexerRuns()`, `prepareIndexerRunsForLanguage()`, and `prepareIndexerRun()` currently pass TypeScript fields through to `config.indexArgs()`.
- **Change**:
  - accept `clojureConfigPath?: string` in the three local option types;
  - pass `configPath: opts.language === 'clojure' ? opts.clojureConfigPath : undefined` into `config.indexArgs()`.
- **Why**: This keeps the config-path feature scoped to Clojure while preserving the existing TypeScript workspace behavior.

### 2.6 - Pass The Config Path From The CLI Handler

- [ ] **File**: `src/runtime/commands/command-handlers.ts:111-130`
- **Source**: `scip-query code handleReindex -C 12`
- **What**: `handleReindex()` passes `config.indexer?.typescript` fields into `reindex()`.
- **Change**: Pass `clojureConfigPath: config.indexer?.clojure?.configPath`.
- **Why**: `.scipquery.json` should be enough to drive Logseq indexing without editing command-line arguments each run.

### 2.7 - Register The Clojure Indexer

- [ ] **File**: `src/reindex/indexers.ts:12-22`
- **Source**: `scip-query plan-context getIndexerConfig --json`; `scip-query code INDEXER_CONFIGS -C 10`; `scip-query code getIndexerDependencyStatus -C 10`
- **What**: `INDEXER_CONFIGS` is a `Record<SupportedLanguage, IndexerConfig>`, and readiness treats any resolved non-`.NET` indexer as installed/runnable.
- **Change**: Add `clojure` config:

  ```ts
  clojure: {
    language: 'clojure',
    indexerBinary: 'scip-clojure',
    projectLocalBinaries: ['node_modules/.bin/scip-clojure'],
    checkCommand: 'scip-clojure -h',
    markerFiles: ['deps.edn', 'project.clj', 'bb.edn', 'shadow-cljs.edn'],
    installMethods: [
      { label: 'npm', prerequisite: 'npm', binary: 'npm', args: ['install', '-g', 'scip-clojure'] },
    ],
    installUrl: 'https://github.com/PlunderStruck/scip-clojure',
    indexArgs: ({ projectRoot, outputPath, indexerBinary, configPath }) => {
      const args = ['-root', projectRoot, '-output', outputPath];
      if (configPath) args.push('-config', configPath);
      return { binary: indexerBinary, args };
    },
  }
  ```

- **Why**: This gives reindex, setup remediation, `check-deps`, and capability reporting one canonical Clojure indexer definition.

### 2.8 - Keep Clojure Fingerprints Config-Sensitive

- [ ] **File**: `src/reindex/index.ts:904-942`
- **Source**: `scip-query code computeLanguageFingerprints -C 12`
- **What**: fingerprints include languages, TypeScript options, and files, but not Clojure config path.
- **Change**: Include `clojureConfigPath` in the overall and Clojure language fingerprints.
- **Why**: Changing the Clojure config file path should invalidate the Clojure shard.

## Phase 3 - Capabilities, Verification, And Health

### 3.1 - Report Clojure Readiness And Capabilities

- [ ] **File**: `src/runtime/project-readiness.ts:65-91`
- **Source**: `scip-query plan-context getProjectReadiness --json`; `scip-query code LANGUAGE_EXTENSIONS -C 8`; `scip-query code SOURCE_FACT_SUPPORT -C 8`
- **What**: readiness has extension and source-fallback tables keyed by `SupportedLanguage`.
- **Change**:
  - add `clojure: ['.clj', '.cljs', '.cljc']` to `LANGUAGE_EXTENSIONS`;
  - add `clojure` to `SOURCE_FACT_SUPPORT` with `status: 'unavailable'` or `status: 'partial'` and a reason such as: "No Clojure source-fallback parser is registered; Clojure relies on SCIP graph facts from scip-clojure and clj-kondo."
- **Why**: Capability output must say Clojure indexing is available when `scip-clojure` is runnable without claiming TypeScript-style semantic-provider support.

### 3.2 - Add Clojure Cleanup Verification Through clj-kondo

- [ ] **File**: `src/runtime/cleanup-verify.ts:140-176`
- **Source**: `scip-query plan-context detectCheckers --json`; `scip-query code detectCheckers -C 8`
- **What**: `detectCheckers()` returns checkers with `label`, `binary`, `args`, and `coversExtensions`; cleanup-plan verification uses these to decide which files are covered.
- **Change**: If Clojure markers exist and `clj-kondo` or `npx` is available, push a checker covering `.clj`, `.cljs`, and `.cljc`. Prefer local/project `clj-kondo` when present; fallback can be:

  ```ts
  {
    label: 'npx clj-kondo --lint .',
    binary: 'npx',
    args: ['--yes', 'clj-kondo', '--lint', '.'],
    coversExtensions: ['.clj', '.cljs', '.cljc'],
  }
  ```

- **Why**: Cleanup verification needs the project's own language checker. For Clojure, `clj-kondo` is the practical deletion oracle for unresolved var/namespace problems.

### 3.3 - Add A Clojure Health Performance Gate

- [ ] **File**: `src/queries/health/health.ts:609-636`
- **Source**: `scip-query plan-context health --json`; `scip-query code healthBudget -C 12`; `scip-query code runHealthAnalyses -C 10`
- **What**: normal health only applies the large-index candidate scan limit at 75,000 symbols or 5,000 documents. The current Logseq Clojure DB has fewer than those thresholds but manual testing showed `health --json` did not return promptly after about 90 seconds.
- **Change**: First add a regression command in verification that records Logseq `health --json` runtime after Clojure indexing. Only change the budget logic if the regression still exceeds the target. If needed, lower the normal-health scan limit trigger for Clojure-heavy indexes or add a language-aware budget warning.
- **Why**: Health support is not real if it technically starts but is too slow to use on the first target repository.

### 3.4 - Keep Semantic Provider Reporting TypeScript-Only

- [ ] **File**: `src/runtime/project-readiness.ts:195-276`
- **Source**: `scip-query plan-context getProjectReadiness --json`
- **What**: `languageCapability()` reports a TypeScript semantic provider only for TypeScript and otherwise says no semantic provider is registered.
- **Change**: Do not add a Clojure semantic provider in scip-query. Let Clojure use graph facts from `scip-clojure` and `clj-kondo`.
- **Why**: `clj-kondo` is upstream semantic analysis for the indexer, not a scip-query in-process semantic provider.

## Phase 4 - Tests And Docs

### 4.1 - Add Detection And Config Tests

- [ ] **File**: `tests/reindex/clojure-detect.test.ts:new`
- **Source**: `scip-query plan-context detectLanguages --json`; `scip-query code LANGUAGE_MARKERS -C 8`; `scip-query code validateProjectConfig -C 12`
- **What**: detection and config validation are the first layer that currently reject/miss Clojure.
- **Change**: Add tests for:
  - `deps.edn` plus `.clj` detects Clojure;
  - `.cljs` and `.cljc` detect Clojure;
  - `.edn` alone does not detect Clojure;
  - `.scipquery.json` accepts `languages: ['clojure']`;
  - `indexer.clojure.configPath` rejects empty and escaping paths.
- **Why**: These tests protect the detection boundary that feeds reindex, freshness, readiness, and setup.

### 4.2 - Add Indexer Argument Tests

- [ ] **File**: `tests/reindex/clojure-indexer.test.ts:new`
- **Source**: `scip-query plan-context getIndexerConfig --json`; `scip-query code INDEXER_CONFIGS -C 10`; `scip-query code prepareIndexerRun -C 12`
- **What**: `INDEXER_CONFIGS` is the canonical place to translate language support into an executable and args.
- **Change**: Assert that `getIndexerConfig('clojure').indexArgs(...)` returns `scip-clojure -root <root> -output <path>` and appends `-config <configPath>` when provided.
- **Why**: This pins the exact handoff from scip-query to `scip-clojure`.

### 4.3 - Add Readiness And Checker Tests

- [ ] **File**: `tests/runtime/clojure-readiness.test.ts:new`
- **Source**: `scip-query plan-context getProjectReadiness --json`; `scip-query code LANGUAGE_EXTENSIONS -C 8`; `scip-query code SOURCE_FACT_SUPPORT -C 8`; `scip-query code detectCheckers -C 8`
- **What**: readiness and capability output are table-driven and checker-driven.
- **Change**: Add tests that Clojure appears in the capability matrix, reports SCIP indexing through `scip-clojure`, reports no in-process semantic provider, and reports cleanup verification when the Clojure checker is detected.
- **Why**: This protects the user-visible "is Clojure supported here?" experience.

### 4.4 - Add Logseq Smoke Verification Script Or Documented Fixture

- [ ] **File**: `docs/validation/2026-06-28-clojure-logseq-support-result.md:new`
- **Source**: `scip-query code healthBudget -C 12`; `scip-query code handleReindex -C 12`
- **What**: The target repo is Logseq, and manual testing proved graph commands work when the DB is produced externally.
- **Change**: Record the exact post-implementation commands and results:
  - build scip-query;
  - install/link `scip-clojure`;
  - configure Logseq with `languages: ['clojure']` and `indexer.clojure.configPath`;
  - run `scip-query reindex --language clojure --force`;
  - run `stats`, `code`, `refs`, `trace`, `outline`, `deps`, `affected`;
  - run `health --json` and record runtime.
- **Why**: First-class support should be proven on the real Clojure/ClojureScript repository that motivated the work.

### 4.5 - Update User-Facing Docs

- [ ] **File**: `README.md`
- **Source**: `scip-query plan-context getProjectReadiness --json`; `scip-query plan-context detectCheckers --json`
- **What**: README describes prerequisites, capabilities, setup, and health behavior.
- **Change**: Add Clojure/ClojureScript as graph-supported through `scip-clojure`, explain that `clj-kondo` supplies semantic Clojure facts to the indexer, and show a `.scipquery.json` snippet with `indexer.clojure.configPath`.
- **Why**: Users need to understand why Clojure has graph-backed support but not TypeScript-style in-process semantic-provider support.

## Stress-Test Findings

1. Understand before touching: detection, reindex, readiness, checker, and health flows are identified with `plan-context` for `detectLanguages`, `getIndexerConfig`, `getProjectReadiness`, `detectCheckers`, and `health`.
2. Blast radius: `detectLanguages` affects reindex, init, freshness, and readiness; `getIndexerConfig` affects reindex, readiness, and setup remediation. Sources: the affected sections of `scip-query plan-context detectLanguages --json` and `scip-query plan-context getIndexerConfig --json`.
3. Intermediate states: Phase 1 compiles only once all `Record<SupportedLanguage, ...>` maps are updated. Ship Phase 1 and Phase 2 together.
4. Reversibility: all changes are additive config/type/indexer additions. Rollback is removing `clojure` from the language tables and config path plumbing.
5. Failure design: missing `scip-clojure` follows existing skipped-language/auto-install behavior in `prepareIndexerRun()`. Source: `scip-query code prepareIndexerRun -C 12`.
6. Concurrency: reindex remains inside the existing lock and temporary-output flow. Source: `scip-query code reindex -C 12`.
7. Boundary defense: `configPath` must be validated inside `validateProjectConfig()` and must not escape the project root. Source: `scip-query code validateProjectConfig -C 12`.
8. Data integrity: no schema change is required. The output remains SCIP plus SQLite, produced through existing reindex materialization.
9. Observability: skipped indexers and auto-install failures already report status messages through `prepareIndexerRun()`. Source: `scip-query code prepareIndexerRun -C 12`.
10. Human experience: `status --capabilities` must say Clojure indexing is available while semantic provider is unavailable/graph-backed, avoiding false confidence.
11. Reuse: the plan reuses existing language tables, indexer config, checker detection, and health budget. Reuse audit commands are recorded above.

## Execution Order

1. Phase 1 and Phase 2 together: language catalog, detection, config path, indexer registration, reindex plumbing.
2. Phase 3: readiness/capability output, checker verification, health performance gate.
3. Phase 4: tests, docs, and Logseq validation artifact.

Phase 1 alone is not deployable because adding `clojure` to `SupportedLanguage` without every `Record<SupportedLanguage, ...>` entry will fail typecheck. Phase 1 plus Phase 2 is deployable as indexing support. Phase 3 makes the support honest in status, setup, verification, and health. Phase 4 makes it shippable.

## Ship Order

1. Land scip-query support behind normal detection and explicit `languages: ['clojure']`.
2. Validate against Logseq with local or globally installed `scip-clojure`.
3. If Logseq health still exceeds the runtime target, land a second small health-budget patch with the recorded evidence.
4. After `scip-clojure` is published on npm, optionally add it as an optional dependency and switch the install docs from link/global install to the published package.

No one-way doors are present. The only external dependency is `scip-clojure`; if it is missing, existing indexer skip/auto-install behavior handles it.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- `scip-query reindex`
- `scip-query diff-gate --json`
- In Logseq, after configuring Clojure:
  - `scip-query reindex --language clojure --force`
  - `scip-query status --capabilities`
  - `scip-query stats`
  - `scip-query code frontend.commands:get-matched-commands -C 4`
  - `scip-query refs frontend.commands:get-matched-commands`
  - `scip-query trace frontend.commands:get-matched-commands`
  - `scip-query outline src/main/frontend/commands.cljs`
  - `scip-query deps src/main/frontend/commands.cljs`
  - `time scip-query health --json`

## Summary

Expected modified files:

- `src/domain/config-types.ts`
- `src/runtime/config.ts`
- `src/reindex/detect.ts`
- `src/reindex/indexers.ts`
- `src/reindex/index.ts`
- `src/reindex/project-files.ts`
- `src/source/source-fileset.ts`
- `src/runtime/project-readiness.ts`
- `src/runtime/cleanup-verify.ts`
- `src/runtime/commands/command-handlers.ts`
- Clojure-focused tests under `tests/`
- `README.md`
- `docs/validation/2026-06-28-clojure-logseq-support-result.md`

Expected net code delta: medium, mostly table additions and option plumbing. No schema migration, no new runtime subsystem, and no in-process Clojure semantic provider.
