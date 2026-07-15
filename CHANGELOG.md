# Changelog

All notable changes to `scip-query` are documented here. This file starts at 0.11.0; everything below covers behavior changes made since the 0.10.12 release.

## [Unreleased]

## [0.17.2]

### Performance (agent command latency)

- `code`, `outline`, and `refs` now load leaf command descriptors instead of initializing the complete command catalog, while invocation-scoped Git/worktree context and generation freshness are reused across command setup. The measured navigation campaign records stable output contracts across clean, dirty, and watcher-backed runs.
- `affected` batches compiler-backed caller evidence once per breadth-first frontier. `plan-context` reuses those batched callers, single-file dependency edges already computed by `system`, and the invocation's resolved Git HEAD instead of repeating equivalent graph and Git work.
- `diff-impact` derives changed names, line ranges, renames, and deletions from five shared Git reads instead of nine overlapping subprocesses. The final campaign snapshot reduced warmed medians from 1,722 ms to 802 ms for `plan-context`, 941 ms to 304 ms for `affected`, and 1,342 ms to 575 ms for `diff-impact`; same-build A/B runs preserve byte-identical output for each retained change.

### Fixes (worktree freshness and watcher reuse)

- Worktree identity, shared-generation leases, CLI preparation, and watch-service reuse now carry one resolved Git context through the invocation. Cache trust is rejected when committed trees or worktree ownership differ, while unchanged generations avoid redundant hashing and subprocess probes.

## [0.17.1]

### Fixes (worktree watcher isolation)

- Automatic refresh now persists and validates the Git worktree identity of each daemon. Every default-managed worktree starts or reuses its own watcher, watches only its own checkout, and sends reindex output only to its own writable cache; portable source subscriptions detect ordinary unstaged edits on Node 18 Linux, Git polling independently detects `HEAD` and index changes, and `watch --status` reports the bound root and worktree ID.

## [0.17.0]

### Performance (Git worktree warm starts)

- Clean Git worktrees at the same repository snapshot now warm-start from one immutable shared index generation while retaining separate writable local caches. Concurrent cold worktrees coordinate one generation build, dirty edits stay isolated to their checkout, safe content-keyed evidence reads through a bounded repository database, and managed caches for removed worktrees are reclaimed automatically. `SCIP_QUERY_SHARED_CACHE=0` disables the behavior, and explicit cache/database overrides remain private.
- Shared-generation reuse now verifies producer compatibility, complete peer artifacts, SQLite state, and full source stability. Hydration rolls back the complete prior local cache on failure; cleanup coordinates with lease writes and protects live watcher/build/hydration processes, ownership checksums, and physical path containment.

### Accuracy (effectiveness verification)

- Effectiveness events now preserve the resolved Git comparison commit. After `HEAD` advances, a clean gate run replays the original comparison before marking a finding fixed: committed defects remain open, committed repairs receive verified credit, moving refs cannot change the baseline retroactively, and dirty or unavailable replays remain pending. Legacy events stay readable and retain their existing conservative classification.

## [0.16.1]

### Fixes

- Outcome history now uses one committed `.scipquery/events/*.json` file per event instead of appending to `.scipquery/ledger/events.jsonl`. This makes concurrent branch writes touch independent paths. The reader remains backward compatible, and the next gate write migrates valid legacy records before removing the old file and its scoped merge rule.

## [0.16.0]

### Notable (setup and automatic indexing)

- **`setup` is now an interactive project wizard.** In a terminal, `scip-query setup` presents a keyboard-controlled checklist for detected language indexers, detected Tree-sitter AST parsers, bundled agent skills, checkout-local hooks, automatic refresh, and the optional initial health audit. `--yes` accepts the recommended defaults for automation, while `--json` remains non-interactive. The redraw logic keeps the checklist anchored while moving with the arrow keys.
- **Detected AST parser packages can be installed by setup.** Setup installs the Tree-sitter runtime and detected language grammars using the versions pinned by `scip-query`, then probes them again and reports any recovery action. Developers no longer need to discover the package-specific npm commands themselves.
- **Automatic indexing is demand-started and project-local.** Setup enables automatic refresh unless an existing project explicitly opted out, starts or reuses the checkout's watch service, and verifies the service deadline and language capabilities. The service wakes when the project is used, idles when there is no work, and keeps hook preferences in ignored checkout-local files rather than repository records.
- **Setup guidance now describes the optimal TypeScript and Rust paths.** The bundled `scip-setup` skill and README cover TypeScript SCIP indexing, persistent `ts-morph` semantics, conditional workspace project shards, Rust SCIP indexing through `rust-analyzer`, durable demand-started Rust semantic sessions, Tree-sitter fallbacks, capability verification, and the distinction between committed records, checkout preferences, and user-environment changes.

### Performance (eliminating repeated work)

- **Incremental TypeScript SCIP documents and semantic fragments.** TypeScript indexing persists per-document SCIP fragments, computes a conservative affected-file closure, and republishes only affected documents into generation-based SQLite indexes. Shadow-mode measurements expose predicted versus actually changed documents before the affected-set optimization is trusted for a project.
- **Persistent TypeScript semantic sessions.** Repeated semantic queries reuse loaded TypeScript projects and exact caller/reference fragments across requests and processes. Workspace mode updates only the owned project and invalidates dependent projects when necessary; a single-project repository continues to use the compiler project's own incremental behavior rather than being artificially split.
- **Generation-based SQLite publication and repair.** Incremental index updates publish an immutable generation and atomically make it current, retain a recovery generation, and diagnose or repair damaged generation state instead of forcing every refresh through a full rebuild.
- **Durable Rust semantic reuse.** Rust semantic queries reuse complete `rust-analyzer` responses through a readiness-aware durable session, with ordered protocol barriers, deadline-bounded synchronization, stale-response rejection, and worker fallback. A stopped durable session in `status` means demand-idle, not unavailable.
- **Faster cold TypeScript dead analysis and `twin-drift`.** Exact TypeScript caller resolution is batched and cached, while full `twin-drift` scans prune impossible candidates earlier and use indexed lookup paths.
- **New repeated-work instrumentation.** Work identities and `work-audit` profiles attribute repeated computation to subsystems so optimization candidates can be selected from measured reuse misses instead of command-level wall time alone.

### Accuracy and credibility

- **TypeScript detector certification.** Factual dead-code evidence and TypeScript graph, architecture, React, and Vue signals gained calibrated fixtures and evidence contracts. Vue reference identities are qualified correctly, navigation callers exclude reference-only edges, and capability output distinguishes syntax-only checks from semantic verification.
- **Rust detector hardening.** Dead-code evidence now preserves implicit imports and excludes trait requirements, trait implementations, convention-driven twins, and trait wrappers where the apparent duplicate or unused symbol is part of Rust's language contract. Signature candidates are restricted to cases the available evidence can support.
- **Python detector hardening.** Python liveness now preserves runtime exports, protocol hooks, and model/framework conventions that consume symbols indirectly.
- **Investigatory health findings are labeled as candidates.** Composite health output discloses capability limits and keeps heuristic findings investigatory instead of presenting them as automatically actionable facts. Accuracy roadmaps now record which detector families were calibrated, certified, unsupported, or deliberately limited.

### Fixes and maintenance

- Setup now applies automatic-refresh defaults consistently and keeps local setup preferences separate from committed repository records.
- Full-result query limits remain within SQLite's parameter limits instead of failing on large candidate sets.
- The repository's own actionable health findings were resolved; remaining reviewed signals are recorded as explicit suppressions rather than silently ignored.

## [0.15.0]

### Breaking (behavior change for one command)

- **`suppress` writes one file per suppression instead of appending to `.scipquery.json`.** New suppressions land in `.scipquery/suppressions/<finding-id>.json` (check-level suppressions get a stable `CHECK-<hash>.json` name), stamped with `createdAt`. One-file-per-suppression makes concurrent branches merge without conflict and stops the config file from churning on every acceptance. Existing `suppressions[]` entries in `.scipquery.json` keep working (the gate reads both stores, identical matching semantics) — they are just no longer written. Commit the suppression files with your change.

### Notable (new capabilities)

- **`setup` now completes automatic-indexing installation instead of only describing it.** A project with no prior watch decision gets `watch.enabled: true`; an existing explicit `false` remains an opt-out, and `setup --guided` presents enablement as a recommended consent choice. Setup starts or reuses the project service after reindexing, verifies its published clean-idle deadline, and reports Rust's final durable/worker transport, lifecycle state, and fallback after the health audit. The status read itself is passive; semantic health work may legitimately wake rust-analyzer. `init` now writes the same enabled demand-started default.
- **Committed outcome-event ledger.** Hook-mode `diff-gate` runs now mirror finding transitions (caught / resolved / suppressed / reopened) into `.scipquery/ledger/events.jsonl` — an append-only, one-event-per-line log stamped with the HEAD commit and, when known, the finding's SCIP symbol. A scoped `.gitattributes` (`merge=union`) is written alongside it, so concurrent appends from different branches merge without conflict; read-side dedupe by `(check, findingId, event, commit)` absorbs replays. Unlike the per-machine `evidence.db` ledger, this file is meant to be committed: outcome history survives re-clones and aggregates across every machine and agent working the repo. Ledger writes never block the hook — failures degrade to a stderr note.
- **New command: `effectiveness`.** Reads the committed event ledger and reports, per diff-gate check: findings caught, fixed by code changes (disappeared without a suppression), suppressed, still open, reopened, `moved` (rename noise — a resolved id whose symbol was re-caught under a new id at the same commit), precision (fixed ÷ concluded), and median days-to-fix. `--since 30d|12w|<ISO date>` windows by when the finding was caught, `--check <name>` filters, `--json` emits the standard envelope. This is the tool keeping score on itself: suppressions count against a detector's precision, fixes count for it.
- **Setup now reports and enforces ownership scopes.** Guided actions and setup results identify repository records to commit, checkout preferences to keep local, and user-environment changes. Project hooks always target `.codex/hooks.json` and `.claude/settings.local.json`, are excluded through `.git/info/exclude`, and refuse to alter an already tracked target. `--shared` remains accepted as a deprecated compatibility flag but no longer writes tracked Claude settings. Guided indexer consent now controls the installer, and the decorative parser-runtime question was removed.
- **Installed Stop hooks now update effectiveness history.** The normal `hook-stop` path shares the same caught/resolved/suppressed/reopened recorder as legacy `diff-gate --hook`, including clean runs that resolve earlier findings. Generated agent guidance requires committing suppression and outcome records while forbidding commits of checkout hook files; project uninstall names those shared records as intentionally preserved.

### Breaking (behavior change for one config key)

- **A non-empty `indexer.typescript.projects` list is now authoritative.** When set, exactly the listed projects are indexed: automatic tsconfig discovery does not run and the repo root is no longer re-added alongside the list (even when the root tsconfig covers subdirectories). Files covered only by an excluded root tsconfig (e.g. shared ambient `.d.ts` files) drop out of the index — pick the list deliberately. An empty or absent list falls back to full discovery, unchanged. Previously the configured list was merged additively with discovery, which made it impossible to exclude a whole-repo root shard.

### Notable (new capabilities)

- **Per-project TypeScript shard caching in workspace mode.** With `indexer.typescript.projectMode: "workspace"`, each tsconfig project shard now has its own fingerprint and cached SCIP artifact (`language-indexes/typescript-projects/`); a reindex after an edit reruns only the changed projects and their dependents instead of every shard. Dependency edges come from workspace `package.json` dependencies and tsconfig `paths`/`references` targets (resolved through `extends` chains); unparseable manifests fail toward depend-on-everything, so the cache can over-invalidate but never serve a stale shard. Every per-project reuse decision appears in `reindex --json` shard diagnostics with an explicit miss reason (`typescript:<project>` entries). Metadata stays v3-additive: older binaries ignore the new field, and older metadata simply classifies every project as a miss. Measured on a 2,438-file four-package monorepo: full rebuild 57s (single mode) → 27s; reindex after an edit in a leaf package 35s → 9.5s.

## [0.11.0]

### Breaking (one-way doors — read before upgrading)

- **`npm install` no longer installs anything beyond the package itself.** Postinstall used to symlink skills into your home directory and could shell out to `brew`/`go install` for missing toolchains. It now prints exactly one line — `scip-query installed -- run 'scip-query setup' in a repo to enable skills, hooks, and the index.` — and does nothing else. Run `scip-query setup` explicitly in a project to get skills, hooks, and a first index.
- **Project hooks are checkout-local.** `scip-query setup` (and `setup-hooks`) write Codex and Claude Code hooks to `.codex/hooks.json` and `.claude/settings.local.json`, exclude both through `.git/info/exclude`, and will not mutate a path Git already tracks. A teammate's agent tooling preferences therefore do not land in Git. The old `setup-hooks --shared` input is deprecated and now has the same local behavior. `setup-hooks --remove` writes an ignored decline tombstone so a later `setup` won't silently re-add hooks you removed; `--force` overrides it.
- **Suppression IDs use a new stable hash.** `.scipquery.json` suppression `id`s are now derived from `(check, symbol, file)` only, not the full match set, so an unrelated new similar function elsewhere no longer silently un-suppresses an accepted finding. Existing legacy-format IDs still match (dual-matching) — nothing in your config needs to change today — but `config-validate` now prints an info diagnostic naming the stable replacement for each legacy entry.
- **Windows no longer ships a vendored `scip.exe`.** The 39 MB vendored binary is gone. Windows installs now receive the binary through `scip-query-scip-windows`, a universal (x64 + arm64) os-gated optional npm dependency fetched only on Windows; resolution order is PATH → `SCIP_QUERY_SCIP_BIN` env → sidecar package → printed instructions. Publishing the main package auto-builds and auto-publishes the sidecar (`prepublishOnly`). Set `SCIP_QUERY_SCIP_BIN` to a local `scip.exe` to override.
- **`convergence` is deprecated.** Use `similar <symbol1> <symbol2> --plan` instead. `convergence` still works (as a thin alias) but is not the documented path going forward.
- **`drift`'s pattern-deviation channel is now opt-in.** The "only sibling in this directory depends on X" noise channel used to run by default; it now requires `--patterns`. `drift` also gained `-n/--limit <n>` (default 50) — previously unbounded output could reach hundreds of KB on a large repo. Unused-import and layer-violation findings are unaffected and still run by default.
- **`doc-reference` findings are now split by citation granularity.** Only line-anchored citations (`file.ts:123`) or citations of a file that was deleted/renamed still block `diff-gate`. A bare file-mention citation (no line anchor) is now advisory: it prints and is suppressible but never fails the gate by itself.
- **`tla verify` groups findings by default.** Human-mode output now prints findings grouped by `(category, modelElement)` with a count and up to 3 exemplars per group, instead of every finding individually — one Vega-scale model previously produced 10,724 lines of output from a handful of root causes. Pass `--full` to get the old ungrouped behavior. `--json` is unaffected except for a new `findingGroups` summary alongside the still-complete `findings` array.

### Notable (new capabilities)

- **New commands:** `duplicate-bodies` (finds byte-identical small callable bodies across files — the "same helper copy-pasted into seven files" shape `similar`'s shape-based scoring is too coarse to catch), `twin-drift` (finds same-name or near-name functions across files whose bodies have diverged — a signal one side got a fix the other never received), `uninstall` (reverses `install-skills`/`setup-hooks`, with `--dry-run`), and the `tla` model-checking family: `tla scaffold` (draft a TLA+ spec/config/mapping from indexed code), `tla instrument` (generate a trace recorder plus wiring sites), `tla trace-check` (prove a recorded execution is a legal model transition via the real TLC checker), and `tla fetch-tools` (download the sha256-pinned `tla2tools.jar`). This release also adds `tla verify`/`trace-check --timeout-ms` and `tla verify --full`.
- **`tla verify` actually verifies now.** Declared `reads` are checked against a static scan (not just parsed and ignored); variable/action referents that resolve to a type instead of a value produce a hard error; every waiver requires a reason and is counted in the output; the checker's config `INVARIANT`s are cross-checked against the mapping's declared invariants. A PASS with unwaived findings is no longer possible, and the proof summary is itemized (`writes: N verified, M waived`, etc.) instead of a single overclaiming sentence.
- **Two new `diff-gate` checks:** `twin-partner` (advisory — a changed symbol has a same-name twin elsewhere that this diff left untouched) and `coverage-contract` (a configured `.scipquery.json` `coverageContracts` entry drifted from its ground-truth source — enumeration rot).
- **Three new lens skills:** `scip-twin-drift`, `scip-claim-audit` (classify whether an "available"/"verified"/"safe"/"PASS" claim is derived from a real check or merely asserted), and `scip-probe-reachability` (prove whether a parser/AST branch is actually reachable by running the real parser on minimal inputs).
- **Skill set consolidated.** `scip-adoption`/`scip-query-setup` merged into `scip-setup`; the four-skill cleanup family collapsed into `scip-cleanup-audit` (report-only, three modes) and `scip-cleanup-improve` (autonomous fixing loop); every workflow now closes out through a single `scip-verify` skill instead of duplicated inline postchecks.
- **Skill set standardized on the `scip-` prefix.** `concrete-plan` → `scip-concrete-plan` and `tla-model-system` → `scip-tla-model-system`; `install-skills` prunes the old symlinked names automatically on the next run, no manual cleanup needed. `_shared` is the one intentional exception (reference infrastructure loaded by other skills, not user-invoked).
- **New skill: `scip-conductor`.** Bundles the previously user-global-only "conduct a multi-phase program" method (plan, delegate, verify handoffs, close, with pre-registered benchmarks) as a first-class installed skill, routed from the `scip-query` router with a tie-break against `scip-concrete-plan` (one change vs. a program of changes with delegation).
- **README documents every bundled skill.** A new "Bundled skills" table in README.md lists all 25 installed skills with a one-line essential-difference summary each, explicitly disambiguating the clusters that are easy to confuse (`scip-concrete-plan` vs `scip-conductor`, `scip-cleanup-audit` vs `scip-cleanup-improve`, `scip-verify` vs `scip-integrity-audit` vs `scip-maintainability` vs `scip-twin-drift`, `scip-directory-architecture` vs `scip-maintainability`).
- **`analysisBudget` JSON disclosure extended to every budgeted command.** Previously only `diff-gate --json` disclosed when a large-index scan cap engaged. Now `change-surface`, `incomplete-migration`, `dataflow`, `slice`, `plan-context`, `complexity`, `dead`, `extract-candidates`, `locality-candidates`, `cleanup-plan`, `recent-duplicates`, and every command built on the generic list/report/table command builders (`refs`, `imports`, `trace`, `similar`, `drift`, `isolated`, `unused-params`, and more) include an `analysisBudget` field in their JSON envelope whenever a cap engaged (omitted otherwise) — a reduced-coverage pass no longer presents as a full one to a JSON consumer.
- **Every command's evidence tier is now architectural, not per-command artisanal.** Human output prints a heuristic disclaimer and `--json` stamps an `evidence: "graph-fact" | "heuristic" | "mixed"` field for every command, driven by the descriptor registry rather than five different disconnected mechanisms. "Safe to delete" language is gone everywhere except compiler-verified (tier-4) output — cleanup findings now read "deletion candidates; confirm with cleanup-plan --verify."
- **`cleanup-plan --verify` reads the real checker exit status.** The banner is now `VERIFIED (<oracle>)` (naming `tsc`, `go build`, `ruff`, `python-compileall`, `clj-kondo`, or `cargo check`) instead of a blanket "COMPILER-VERIFIED", and it discloses when working-tree files outside the plan were dirty at verification time.
- **`finding-outcome ledger` and precision reporting.** `diff-gate` now tracks each check's resolution/suppression rate over time; low-precision checks surface a nudge in `--hook` mode, and `health --json` reports `detectorPrecision` per check.
- **Snapshot-doc policy.** `.scipquery.json`'s `docs.snapshotPaths` globs (or an inline `<!-- scip-query: snapshot -->` marker) exempt dated ledger/report docs from `doc-reference`/`doc-drift` findings, eliminating a recurring wall of false doc-drift positives on append-only docs.
- **Health dogfood: 97 → 100.** The layer policy gained `runtime → tla` (the CLI layer importing its own query module, the established pattern) and `src/core` is now a legal dependency for `source`, `semantic`, `runtime`, `tla`, and `language-parsers`. `escapeRegex` moved to a new zero-dependency `src/core/regex-utils.ts`, restoring the documented invariant that `src/semantic` never imports `src/source`. `binaryAvailable` moved to `src/core/command-availability.ts`; the shared download/checksum/cache primitive both `tla fetch-tools` and the Windows `scip.exe` fetcher needed now lives in `src/core/verified-binary-fetch.ts`, letting three prior "we'd extract this but `src/core` isn't reachable yet" suppressions be deleted outright. Four duplicate-body pairs were consolidated into shared helpers; three were left as documented intentional variation (React/Vue parity functions, echo/baseline remediation text) rather than force-merged.

### Fixes (accuracy / false-positive)

- **Three false-dead archetypes fixed.** Symbols consumed only via `import type` across a `tsconfig` path alias are no longer reported dead. pnpm-workspace cross-package consumers are now resolved via a new workspace-package resolver (this also fixed a real bug — `fanInBySymbolId.get(id) === 0` treated an *absent* symbol the same as a zero-reference one, suppressing semantic enrichment broadly, not just for the workspace case). Vue `<script setup>` composable consumers were verified already correct and gained a regression fixture. Where the remaining gap couldn't be closed this release (an ambiguous leaf name across an unresolved barrel re-export hop), the finding is now labeled `unconfirmed` instead of asserted `dead`.
- **`diff-gate` fails closed.** A git-diff-unavailable condition (diff too large for the exec buffer, a bad `--base`, or a git error) now exits nonzero having run zero checks, instead of silently passing.
- **`doc-drift` epoch-0 timestamp bug fixed.** A doc whose only commit touched it as part of a >50-file bulk sweep now falls back to file mtime instead of being reported as "last changed at the Unix epoch."
- **SANY XML export was silently dead code.** `-o <path>` on the SANY invocation meant "offline mode," not "output path" — the real-parser XML export path never actually ran. Fixed the invocation and rewrote the XML grammar parser against real `tla2tools` v1.8.0 output.
- **`tla verify`/`trace-check` timeout misclassification fixed.** `spawnSync`'s own timeout kill has no `ETIMEDOUT` error shape — only `signal: 'SIGTERM'` — so a genuine timeout was previously reported as an ordinary `failed` run. A SIGTERM landing at or after the requested `timeoutMs` boundary is now classified `timed-out`.
- **Calibration retunes from external repo validation:** `duplicate-bodies`' default `--min-loc` raised from 1 to 3 (kills 1-line forwarding-stub noise); `twin-drift` excludes synthetic constructor-style leaves and test-only groups; `co-change` exempts locale/i18n sibling resource files from hidden-coupling findings; `stale-abstractions`/`wrapper-candidates` gained an explicit false-positive-rate caveat and were demoted from the default `cleanup-audit` sweep to an opt-in deep-dive.
- Assorted smaller fixes: parameterized SQL in a scope filter (injection-shaped hygiene, no known exploit), fan-in/hotspot queries no longer counting a symbol's own defining file as a consumer, AST-based cyclomatic-complexity counting, nested `.gitignore` support, and Vue single-file-component script extraction unified across the codebase.

[0.17.2]: https://github.com/PlunderStruck/scip-query/releases/tag/v0.17.2
[0.17.1]: https://github.com/PlunderStruck/scip-query/releases/tag/v0.17.1
[0.17.0]: https://github.com/PlunderStruck/scip-query/releases/tag/v0.17.0
[0.11.0]: https://github.com/PlunderStruck/scip-query/releases/tag/v0.11.0
