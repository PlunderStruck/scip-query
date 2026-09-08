# Incremental TypeScript symbol equivalence repair

Status: resolved, validated, and delivered in this revision.

## Finding and acceptance criteria

A LaunchPoint export edit followed by restoration previously left additional symbol records. Restoring identical source must restore the same compiler facts: complete symbol identifiers and metadata, documents, occurrences, definitions, and references. Comparing counts alone or stripping generated identifiers cannot establish this.

Retain a baseline database, add one export, retain the changed database, restore the exact source bytes, and compare the restored database against the baseline. Require actual incremental publication, valid SQLite integrity and foreign keys, and the probe identifier present only during the addition. Exercise both ordinary and dirty-worktree restoration. Do not weaken resource policy or edit application behavior to avoid unsupported syntax.

## Confirmed causes and final changes

- The pinned scip-typescript 0.4.0 visitor numbered anonymous type literals and inferred object properties using counters belonging to the visiting file. Separate compiler shards could emit different identifiers for the same declaration and its references. A shared full/incremental adapter now derives those identifiers from the declaration's source offset inside the existing upstream package/file namespace. Local declaration caches are reset per incremental emission request.
- Compiler shards previously replaced the compiler's root input list. This omitted global declarations from other files and dropped valid references. Every shard now constructs the complete compiler program and emits only its explicit document subset. The pinned CLI adapter validates the subset before emission. Explicitly trusted repository tools retain their ordinary unsharded path.
- Previous compiler timings and machine concurrency changed shard membership for identical source. Removed the persisted timing model, weight adjustment, recording plumbing, and wave-dependent shard count. Partitioning now depends on source paths, source bytes, and the configured target; concurrency schedules those fixed shards.
- The first repaired VM trial showed that restoring a clean tree could reattach a pre-upgrade shared database. The producer version now participates in project and TypeScript language fingerprints, workspace-shard reuse, watcher/freshness comparisons, and shared-generation identity. Old fragment producer metadata is rejected too. This prevents mixing identifier versions and requires one compatible clean build when upgrading.
- The setup skill explains migration and recovery. No dependency files are modified: the adapter installs in the pinned producer process, and the full compiler entry is shipped in the package.

The initial proposal to reject traversal-dependent declarations and rebuild everything was superseded after real VM validation proved full builds could disagree too. Neither that guard candidate nor the first incomplete migration candidate was installed globally.

## Regression coverage

- Independently expected declaration identifiers and complete reference-to-definition bindings for anonymous types, inferred properties, shorthand properties, repeated property names, and Unicode prefixes; cold and warm subset emitters also match a fresh standalone compiler process.
- A real watcher export addition, declaration-offset shift, and restoration; restored compiler facts and the complete global-symbol catalog must match the retained baseline.
- Complete compiler-program context for ambient declarations across emission shards.
- Identical facts across legacy timing feedback, different shard targets, and different concurrency.
- Rejection of legacy fragment and shared-generation producer identities; an unchanged local index with old producer metadata rebuilds once and then reuses normally.
- Existing freshness/preflight fixtures include the current producer field; an explicitly missing field is tested as stale.

The standalone compiler oracle shares the production identity adapter but runs independently of retained state, the affected-set planner, and publication caches. Literal identity and binding assertions independently test the adapter's naming guarantee. No normalization removes identity differences.

## Retained LaunchPoint evidence

VM SSH profile: `dev-agent` (Unix user `launchpoint-agent`, UID 1002).

Validation worktree: `/tmp/scip-query-equivalence-20260908/launchpoint-validation`, detached at `3989b65ab95c4684e288ae5bb4e1525570650c5f`. The primary application checkout was not edited.

Final evidence directory: `/tmp/scip-query-equivalence-20260908/identity-validation-v2/`.

| Phase | Publication | Documents | Symbols | Wall time |
| --- | --- | ---: | ---: | ---: |
| Clean baseline | full | 8,762 | 467,325 | 154.77 s |
| Export addition | incremental | 8,762 | 467,326 | 32.47 s |
| Source restoration | incremental | 8,762 | 467,325 | 19.51 s |
| Dirty-worktree addition | incremental | 8,762 | 467,326 | 18.90 s |
| Dirty-worktree restoration | incremental | 8,762 | 467,325 | 19.45 s |

Both restorations reproduce all five baseline table digests exactly. Comparisons retain complete identifiers, documentation, signatures, enclosing symbols, relationships, document text/encoding, occurrence blobs, definition ranges, and mentions. Allocation-only database IDs are replaced with their referenced document paths and symbol strings before comparison. Every retained database passes SQLite integrity and foreign-key checks. The exact probe symbol is present only in the addition databases. Final status is fresh.

The first verification script mistakenly searched `display_name`, which is null for this variable. Verification was corrected to use its full symbol identity against the already-retained databases, and then resumed the remaining dirty-worktree cycle. No compiler facts or source behavior were changed to satisfy that assertion.

Older failed candidate artifacts remain separately retained for diagnosis. The earliest historical baseline was not retained, so the original 73-record residue cannot be individually reconstructed from those earlier artifacts.

## Completion checklist

- [x] Reproduce identifier/reference mismatch and ambient-context loss with small tests.
- [x] Implement shared declaration identities and full-program emission subsets.
- [x] Remove timing-driven shard feedback and traversal caches across requests.
- [x] Protect all relevant reuse paths against old producer identities.
- [x] Update setup guidance and producer-migration tests.
- [x] Verify two exact LaunchPoint round trips with retained databases.
- [x] Review current source: 573/573 eligible files, zero findings, no missing/ambiguous internal imports or group cycles.
- [x] Final suite: 3,426 tests across 396 files passed. Final indexing properties: 19 tests, 200 component cases, 5 integration cases, 2 system cases, 30 compiler histories, and 12 exhaustive short histories / 21 checkpoints; seed 20260908. Receipt: `/var/folders/4c/wsjvhgw90t7f31d7s68ddhtc0000gn/T/scip-query-properties-LYWeG9/summary.json`. Build, lint/API/skill links, type checks, final targeted ESLint, and diff whitespace checks passed.
- [x] Canonical VM install replaced at `/home/launchpoint-agent/.local/lib/node_modules/scip-query`; 459 package files including 19 skill files verified by SHA-256, both Codex/Claude skill-link sets verified, all six existing watchers restarted. Archive SHA-256: `eeeb16fdd44e1aaf95079b9787e23b9156286af184ac4d3c7f86cd09b808a6b2`. Primary LaunchPoint migration completed in 151.24s with no skipped language; final status fresh. All seven pre-existing dirty documents retain their original hashes.
- [x] Removed the owned temporary validation worktree/cache and superseded private candidates; retained validation databases, reports, package archives, and the canonical rollback package.
- [x] Commit the repair on main; verify the remote revision during delivery.

Fresh post-change diff-impact mapped 44 changed symbols to 33 consumer files. Twelve changed paths were outside the semantic index (including docs/test surfaces); current-source review independently covered all 573 eligible production files. Local exploration watcher was stopped after verification.
