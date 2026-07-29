# Lightweight Watcher Program

Date: 2026-07-29

## Goal

Keep automatic SCIP evidence fresh while making the steady-state watcher cheap
enough to leave enabled everywhere. Completion means that:

1. a command which cannot benefit from a fresh compiler index does not start a
   background watcher;
2. filesystem and Git activity which cannot change compiler output does not
   request a rebuild;
3. source-edit bursts settle before the first automatic rebuild;
4. an unused demand-started watcher exits after three quiet minutes rather than
   ten;
5. automatic rebuild admission defaults to two rebuilds or 1 GiB of estimated
   writes per 15 minutes;
6. a change invalidates only the language shards whose actual compiler inputs
   changed; and
7. status/activity evidence identifies the language-level work and unavoidable
   artifact bytes, so later optimization is based on measured cost.

Every implementation slice is independently tested and committed. The
completed disk-pressure remediation is checkpointed separately at `1576b3e5`;
it is the starting point, not one of the slices below.

## Definitions and Invariants

A **demand-started watcher** is the repository-scoped background process which
is created by an index-dependent CLI invocation, owns the exclusive watcher
lock, subscribes to project changes, and exits after a bounded period with no
useful activity. Its essential characteristic is that demand, rather than
login or machine boot, owns its lifetime. Source:
`src/runtime/cli.ts:55-105`, `src/runtime/watch-service.ts:188-226`,
`src/runtime/watch-server.ts:315-366`.

An **index input** is a repository file whose bytes or presence can change the
SCIP documents produced for at least one configured language: source files,
ambient declarations, compiler/build manifests, dependency locks, and
`.scipquery.json`. The existing `classifyProjectInputPath` and
`isLanguageRelevantProjectInputPath` functions are the canonical classifiers;
documentation, review records, agent settings, and detector event records are
not compiler inputs. Source: `src/domain/project-input.ts:59-93`,
`src/platform/project-files.ts:221-230`.

A **quiet period** is the reset-on-every-input timer between the most recent
index-input event and admission of the next rebuild. Resetting the same timer
is what makes it adapt to a burst: a burst of any length becomes one rebuild
only after the last relevant event, without requiring a second frequency
controller. Source: `src/runtime/watch.ts:357-392`.

A **language shard** is the cached SCIP artifact and input fingerprint for one
configured language. Its defining property is independent reusability: when
that language's fingerprint is unchanged, the merged index may reuse the
artifact without executing that language's indexer. Source:
`src/reindex/index.ts:647-684`, `src/reindex/index.ts:1127-1210`.

**I1.** A CLI command starts or reuses a demand watcher iff the command can
benefit from a fresh compiler index and automatic watching is enabled.

**I2.** A filesystem event requests automatic indexing iff it identifies an
index input for at least one configured language. Directory events never
request indexing; their contained file events carry the evidence.

**I3.** A Git-state transition requests automatic indexing iff the changed
HEAD/index paths include an index input, or the changed-path comparison cannot
be established. Uncertainty fails toward freshness; a proven docs-only
transition does not rebuild.

**I4.** All relevant events in one edit burst collapse into one quiet-period
timer and at most one trailing dirty refresh. The timer is owned and cleared by
the watcher shutdown path.

**I5.** Automatic admission is bounded by persisted evidence. Restarting the
watcher does not reset the two-run/1-GiB rolling debt, and manual reindex
remains available.

**I6.** Per-language reuse is sound: a shard is reused only when every input
which can affect that language has the same fingerprint. Narrowing a
language's config-input set must never exclude a file that its indexer reads.

**I7.** Cost reporting distinguishes produced language artifact bytes,
reflinked staging bytes, fallback-copied bytes, and final logical output.
Telemetry describes observed program work; it does not claim device-level
physical-write precision.

## Premises

**P1.** The CLI pre-action independently asks whether shared-cache preparation
and watcher auto-start are eligible, resolves project context only when either
is true, and calls `ensureWatchServiceForCommand` only for an auto-start
eligible command. Source: `src/runtime/cli.ts:55-105`.

**P2.** Auto-start uses one negative command set. It already excludes
`config-validate`, hook internals, init/setup/setup-agent/setup-ci/setup-hooks,
reindex, watch, work-audit, and internal `__*` commands, but not
`install-skills`, `status`, `doctor`, or `effectiveness`. Commander's
top-level `--version` does not enter a command action. Source:
`src/runtime/watch-service.ts:53-71`, `src/runtime/watch-service.ts:188-226`;
descriptor identities in `src/runtime/commands/command-descriptors.ts`.

**P3.** Complete compiler-resolved consumers of
`watchServiceAutoStartEligible` are `src/runtime/cli.ts` and
`ensureWatchServiceForCommand`; tests are non-production consumers. Source:
`scip-query refs watchServiceAutoStartEligible --full`, run 2026-07-29.

**P4.** The source watcher currently passes all Chokidar event kinds to
`handleFileChange`, then schedules every non-ignored path except index/activity
artifacts. It therefore treats directory, Markdown, event-record, and agent
configuration changes as compiler inputs. Source:
`src/runtime/watch.ts:288-355`.

**P5.** `classifyProjectInputPath` already returns `source`, `ambient`,
`config`, or `other`, using configured-language extensions and a manifest/lock
set. Its complete compiler-resolved consumers are project change manifests,
TypeScript incremental identity, and TypeScript semantic identity. Source:
`src/domain/project-input.ts:59-75`;
`scip-query refs classifyProjectInputPath --full`, run 2026-07-29.

**P6.** Git polling currently compares only HEAD identity and Git-index
path/mtime/size. Any commit or index rewrite can therefore schedule a reindex
without proving that a compiler input changed. Source:
`src/runtime/watch.ts:625-680`.

**P7.** The current default quiet period is 250 ms. The timer is already reset
on every relevant call to `scheduleReindex`, so increasing it to 2,000 ms is
both a fixed quiet-period change and burst settling; a parallel rate heuristic
would add state without collapsing any additional events. Source:
`src/runtime/config.ts:22-49`, `src/runtime/watch.ts:357-392`.

**P8.** The current idle default and generated setup value are 600,000 ms.
`watch-server` derives its externally visible deadline and exit decision from
the resolved value. Source: `src/runtime/config.ts:24-49`,
`src/runtime/config.ts:779-799`, `src/runtime/watch-server.ts:173-189`,
`src/runtime/watch-service.ts:615-625`.

**P9.** The current automatic budget defaults are a 15-minute window, four
rebuilds, and 4 GiB of estimated writes. The ledger persists across restarts;
manual runs are recorded into the same evidence. Source:
`src/runtime/config.ts:24-49`, `src/reindex/reindex-activity.ts`,
`src/runtime/watch.ts:396-428`.

**P10.** Reindex already computes a project fingerprint and per-language
fingerprints, caches one SCIP artifact per language, and executes only language
shard misses. TypeScript workspace mode adds a finer project-shard layer.
Source: `src/reindex/index.ts:647-684`, `src/reindex/index.ts:717-824`,
`src/reindex/index.ts:1127-1210`.

**P11.** `isLanguageRelevantProjectInputPath` currently includes every
`COMMON_INDEX_INPUTS` entry in every language fingerprint. Thus a
`package-lock.json` edit can invalidate Rust, Go, Python, and other unrelated
language shards even though their indexers do not read it. Source:
`src/domain/project-input.ts:77-93`, `src/domain/project-input.ts:199-241`.

**P12.** Reindex results already expose one diagnostic per language/project
shard with reuse, miss reason, output bytes, duration, and command. Clone
telemetry is aggregate only. Complete compiler-resolved consumers of
`ReindexWriteTelemetry` are the clone helper, incremental SQLite publisher,
and reindex orchestrator. Source: `src/reindex/index.ts:154-194`;
`scip-query refs ReindexWriteTelemetry --full`, run 2026-07-29.

**P13.** The 24-hour baseline immediately before this program reported 131
runs: 63 rebuilt, 68 reused, 0 failed, 9 redundant refreshes suppressed,
4.1 GiB estimated writes, 86.2 MiB reflinked staging, and 178.6 MiB
fallback-copied staging. Source: `scip-query status --capabilities`, run
2026-07-29 at approximately 12:08 America/Los_Angeles.

## Current Flow

Commander identifies the selected command and the CLI pre-action asks
`watchServiceAutoStartEligible` whether to inspect/start the watcher (P1-P3).
Once started, Chokidar sends every filesystem event into one handler. Literal
ignore rules remove Git/cache artifacts, but no compiler-input classification
occurs, so every remaining path resets the 250 ms timer (P4, P7). Separately, a
two-second Git poll treats HEAD or index metadata movement as a change even
when the changed tree is documentation-only (P6). Admission then checks the
five-second cooldown and persisted four-run/4-GiB budget (P9). Reindex itself
already reuses language shards, but overly global config fingerprints cause
avoidable language misses (P10-P11). Existing diagnostics contain most of the
language attribution needed for measurement but do not persist an activity
summary by language (P12).

## State-Authority Premises

### Watcher startup policy

Writer: the index-independent command set beside
`watchServiceAutoStartEligible`. Readers:
`watchServiceAutoStartEligible`, `ensureWatchServiceForCommand`, and CLI
pre-action through that function. The complete compiler-visible reader set is
P3. Descriptor-registration tests are the non-code completeness oracle: every
registered command must be classified by a test as index-independent or
watcher-eligible.

### Pending automatic refresh

Writers: `requestRefresh`, Chokidar `handleFileChange`, Git `pollGitState`,
cooldown completion, and budget retry. Reader/owner:
`Watcher.triggerReindex`; shutdown clears all timers and rejects new work.
Source: `src/runtime/watch.ts:215-271`, `src/runtime/watch.ts:288-445`,
`src/runtime/watch.ts:597-680`.

### Watch timing and budget configuration

Writers: config initialization and user-authored `.scipquery.json`. Readers:
`resolveWatchConfig`, watcher construction, watch server/service timing,
schema validation, README/setup output, and tests. This was enumerated as P10
in `docs/plans/2026-07-29-watcher-disk-pressure-remediation.md` and remains
unchanged.

### Language shard fingerprint

Writer: `computeLanguageFingerprints` using
`fingerprintProjectFiles(...isLanguageRelevantProjectInputPath)`. Readers:
shard reuse classification, metadata publication, shared-generation
validation, and status diagnostics. The cached fingerprint is authoritative;
watcher classification is only an admission optimization and may conservatively
request a run, but cannot authorize unsafe reuse.

### Activity cost evidence

Writer: `recordReindexRunActivity` after a settled `ReindexResult`. Readers:
status aggregation and watcher resource-budget admission. New language
breakdowns are additive evidence; the aggregate fields remain the admission
authority so old records stay valid.

## Reuse Decisions

- Extend the existing auto-start policy rather than add a second CLI hook.
  Both CLI startup paths already converge on
  `watchServiceAutoStartEligible` (P1-P3).
- Reuse `classifyProjectInputPath` for watcher decisions rather than create a
  watcher-only extension table. This keeps live invalidation and post-reindex
  change manifests tied to one definition of an index input (P5).
- Keep one resettable debounce timer. It already implements burst settling;
  only its safe default changes (P7).
- Extend existing resolved watch configuration and generated defaults; do not
  create environment-only hidden timing/budget behavior.
- Narrow `isLanguageRelevantProjectInputPath` with a per-language manifest map
  rather than teach third-party indexers a fictional generic incremental API.
  The real independently reusable unit for those tools is the existing
  language shard (P10-P11).
- Derive language activity from `ReindexResult.shards`; do not create a second
  timing/profiling subsystem. Additive persisted summaries are decoded
  permissively so historical records remain readable (P12).

## Testability Design

- Pure seam: `watchServiceAutoStartEligible(commandName, env)`; table-driven
  descriptor coverage proves all passive commands and all fresh-index command
  families.
- Pure seam: `classifyWatchSourceChange(eventName, path, languages)` delegates
  file semantics to `classifyProjectInputPath`; table tests cover every event
  kind and language.
- Side-effect shell: Git polling gathers changed paths only after cheap
  HEAD/index metadata changes. Injected Git-state/path readers let tests force
  docs-only, source, and command-failure cases without a real repository.
- Observable watcher tests assert rebuild count and status transitions, not
  private timer calls.
- Pure seam: resolved timing/budget defaults; config tests cover absent,
  legacy-explicit, and user-overridden values.
- Pure seam: per-language config relevance; one table covers all 16 supported
  languages and their manifest/lock inputs.
- Pure seam: activity aggregation from shard diagnostics; backward-compatible
  record decoding and status rendering are tested with old and new records.

## Slices and Commit Boundaries

### Slice 1 — Command-aware watcher demand

Deployable: yes.

Change:

- classify `install-skills`, `status`, `doctor`, and `effectiveness` as
  index-independent for auto-start;
- preserve current exclusions and `SCIP_QUERY_SKIP_WATCH_SERVICE`;
- add registered-command coverage so a new passive command cannot silently
  inherit watcher startup;
- do not change graph/semantic commands, which still demand freshness.

Files: `src/runtime/watch-service.ts`, focused watcher/CLI tests, and command
contract documentation only if user-visible behavior is documented there.

Validation: watcher-service tests; CLI invocation tests proving no daemon for
each passive command and a daemon for a representative graph command;
`diff-impact`; `diff-gate`.

Commit: `fix: avoid watcher startup for passive commands`.

Result: **complete.** `doctor`, `effectiveness`, `install-skills`, and
`status` now return the explicit excluded-command outcome without touching an
existing daemon or spawning a new one. `refs`, `health`, and `plan-context`
remain eligible. The focused contract and real worktree integration suites
pass at 60/60 tests, typecheck passes, the full reference set confirms the
policy has no watch-server or command-handler consumer, and diff-gate passes
with those two broad-sweep co-change counterexamples recorded as evidence-bound
adjudications.

### Slice 2 — Compiler-input-only invalidation

Deployable: yes.

Change:

- reject Chokidar directory events before the canonical source-change
  classifier;
- ignore directory events and files classified `other`;
- use configured languages, conservatively falling back to all supported
  languages when configuration is absent;
- after a cheap Git metadata transition, compare changed HEAD/index paths and
  schedule only if at least one is an index input;
- if Git changed-path evidence fails, retain the current conservative rebuild.

Files: `src/runtime/watch.ts`, `src/domain/project-input.ts` only if the
canonical classifier needs a public helper, focused watcher/project-input
tests.

Validation: docs, `.scipquery/events`, `.claude`, and `.codex` edits launch
zero runs; source/config/ambient adds-modifies-deletes launch one; docs-only
commit/stage transitions launch zero; source transitions launch one; failed
Git comparison launches one.

Commit: `fix: rebuild only for compiler inputs`.

Result: **complete.** Chokidar now admits only configured-language source,
ambient, and compiler/configuration inputs. The shared classifier now includes
Vue single-file components for JavaScript indexing. Git polling compares
successive staged blob identities plus changed HEAD paths, so adding docs to
an index that already contains a staged source file does not repeatedly charge
that source; unavailable Git evidence still refreshes conservatively. The
focused watcher, project-input, and real-worktree suites pass at 50/50 tests;
typecheck, ESLint, build, and the additive public-API contract pass. The
unbounded recent-duplicate scan found no reimplementation, complete paginated
doc-drift output found no Slice-2 documentation defect, and diff-gate passed
with one unrelated advisory guide-reference candidate.

### Slice 3 — Two-second burst settling

Deployable: yes.

Change:

- raise the default and generated setup quiet period from 250 ms to 2,000 ms;
- update this repository's explicit setting;
- retain user values greater than zero—this is a safer default, not a hidden
  minimum;
- document that resetting the timer on every relevant input is the adaptive
  burst behavior, avoiding a redundant frequency state machine.

Files: `.scipquery.json`, `src/runtime/config.ts`,
`src/runtime/project-setup.ts` if generated defaults are duplicated, schema or
README text, config/watcher tests.

Validation: rapid burst produces one run after two quiet seconds; continuous
events keep postponing the same timer; explicit override remains honored;
shutdown cancels it.

Commit: `perf: let watcher edit bursts settle`.

Result: **complete.** The runtime default, generated repository setting,
command help, configuration contract, and README now agree on a two-second
quiet period. The existing single resettable timer remains the burst
coalescer: each relevant input postpones the same deadline, shutdown cancels
it, and explicit positive overrides remain unchanged. Focused config, watcher,
and CLI tests pass at 121/121; typecheck, ESLint, the public API check, command
documentation generation, and diff-gate pass. Four broad co-change
expectations were recorded as evidence-bound counterexamples because the
central default changed without changing the consumers' input contract or the
generated command-reference shape.

### Slice 4 — Three-minute idle lifetime

Deployable: yes.

Change:

- change the runtime and generated setup default from 600,000 to 180,000 ms;
- update this repository's explicit default-derived setting;
- preserve `idleTimeoutMs: 0` as the documented never-exit opt-out and preserve
  explicit custom values;
- keep active/waiting/indexing/cooldown/budget-paused/draining states ineligible
  for idle exit.

Files: `.scipquery.json`, `src/runtime/config.ts`, setup/schema/README text,
watch-server/service tests.

Validation: idle service exits at three minutes; useful activity moves the
deadline; non-idle states do not exit; zero remains unlimited.

Commit: `perf: shorten idle watcher lifetime`.

Result: **complete.** The runtime default, generated repository setting,
command help, configuration contract, README, and setup-facing test fixtures
now agree on a three-minute clean-idle lifetime. Explicit custom lifetimes
remain exact and `0` still disables idle exit. Boundary tests prove that recent
activity renews the deadline and that waiting, indexing, cooldown,
budget-paused, and draining states remain ineligible for idle shutdown.
Focused config, watcher-service, project-setup, and CLI tests pass at 133/133;
typecheck, ESLint, the public API check, generated command documentation, and
diff-gate pass with three evidence-bound co-change counterexamples.

### Slice 5 — Stricter automatic rebuild budget

Deployable: yes.

Change:

- retain the 15-minute rolling window;
- change defaults/generated config from four to two rebuilds and from 4 GiB to
  1 GiB estimated writes;
- update this repository config and operator documentation;
- preserve explicit user values and the enabled=false escape hatch.

Files: `.scipquery.json`, `src/runtime/config.ts`, schema/README, reindex
activity/config/watcher tests.

Validation: second completed rebuild or 1-GiB threshold pauses the next
automatic run; persisted restart debt and manual-run accounting still hold;
explicit overrides remain honored.

Commit: `perf: tighten automatic rebuild budget`.

Result: **complete.** The default persisted rolling window remains 15 minutes,
while automatic admission now pauses at two completed rebuilds or 1 GiB of
estimated writes. Generated configuration, public configuration comments, and
the README agree on those limits. Explicit custom budgets and
`resourceBudget.enabled: false` remain exact; manual runs remain available and
continue contributing to later automatic admission. Focused runtime-config,
activity-ledger, and watcher tests pass at 103/103, including exact default
boundary checks; typecheck, ESLint, the public API check, and diff-gate pass
with one evidence-bound config-test co-change counterexample.

### Slice 6 — Language-specific shard invalidation

Deployable: yes.

Change:

- replace the global `COMMON_INDEX_INPUTS` treatment in language fingerprints
  with one exhaustive per-language manifest/lock mapping;
- retain `.scipquery.json` as global because it changes indexing policy;
- retain source extensions and indexer marker files;
- prove every `SupportedLanguage` has an explicit config-input policy;
- leave TypeScript workspace project-shard reuse intact.

Files: `src/domain/project-input.ts`, project-file and reindex reuse tests;
generated/public API only if exported types change (not expected).

Validation: each language source/config edit invalidates its shard; unrelated
language manifests do not; global config invalidates all; mixed-language real
reindex reruns only the affected language and produces byte-equivalent merged
results.

Commit: `perf: narrow language shard invalidation`.

Result: **complete.** One exhaustive language-input policy now assigns source
extensions, discovery markers, build manifests, and dependency locks to the
indexers that can consume them; indexer descriptors reuse the same marker
authority. Glob markers such as `*.csproj`, nested/custom exact markers, and
TypeScript-family ambient declarations are covered. Whole-project freshness
now fingerprints only canonical index inputs, so documentation, agent files,
and telemetry cannot make an otherwise current index stale. Mixed-language
integration proves `package-lock.json` reruns TypeScript but reuses Rust, while
`Cargo.lock` does the reverse. Focused fingerprint, affected-set, reindex,
watcher, and indexer suites pass at 130/130; typecheck, ESLint, the public API
check, scoped unbounded recent-duplicate analysis, and diff-gate pass. A live
second no-change reindex reused both languages in 0.1 seconds, and the next
TypeScript source refresh reused the Rust shard.

### Slice 7 — Per-language write-amplification evidence

Deployable: yes.

Change:

- aggregate each top-level language shard's reused/produced status,
  `outputBytes`, and duration into the reindex activity record;
- retain project-shard detail in command output but avoid duplicating it in the
  bounded 24-hour ledger;
- summarize produced bytes and reuse counts by language in status;
- state explicitly that final SQLite/index outputs and fallback copies remain
  aggregate costs, because their bytes cannot be assigned honestly to one
  language after merge.

Files: reindex activity types/writer/decoder/status formatter and focused
tests; README/status contract and public API digest if required.

Validation: old records decode unchanged; new mixed-language run attributes
language artifacts exactly once; reused shards report zero produced bytes;
unknown/future language detail is rejected or skipped without corrupting
aggregate admission evidence.

Commit: `feat: report per-language reindex cost`.

Result: **complete.** Each completed run now stores one compact cost row per
top-level language shard: rebuilt/reused state, current shard size, newly
produced bytes, and cumulative indexer time. TypeScript workspace project
shards remain available in command diagnostics but are deliberately rolled up
before the bounded ledger is written. The decoder preserves aggregate
admission evidence from old records and from records containing unknown future
language entries while reporting language attribution as complete, partial, or
unavailable. Human and JSON watch status expose the summary, and README
documentation distinguishes language-produced bytes from unassignable merged
SCIP/SQLite and staging costs. Focused state, ledger, and runtime coverage
passes at 77/77; typecheck, ESLint, build, and the public API compatibility
gate pass. Diff-gate's duplicate-helper finding was fixed; its remaining
architecture citation advisory was inspected and the cited watch-state
contract remains the intended target.

### Slice 8 — Program closure

Deployable: yes; documentation/test-only unless verification finds a defect.

Change:

- run the full suite, typecheck, lint/build/public-API checks;
- run a live passive-command no-start probe, docs-only change probe, source
  burst probe, idle deadline probe, and mixed-language shard reuse benchmark;
- record before/after run counts, rebuild ratio, and bytes;
- update this plan with completion evidence and accepted limitations.

Commit: `docs: close lightweight watcher program`.

Result: **complete.** The full Vitest suite passes at 272 files / 2,183
tests, the Rust workspace passes at 2/2 tests, and full formatting, ESLint,
build, public-API compatibility, public-consumer typechecking, and skill-link
validation pass. After the final presentation repair, the three directly
affected suites pass at 103/103. Human status rounds sub-second indexer
durations instead of exposing performance-timer fractions.

Live probes used an isolated Git repository and isolated cache:

- `status` reported the missing index without creating a watch lock or
  watch-state file;
- a Markdown-only edit left the activity ledger at one run, and the
  12-second probe daemon exited with both ownership files removed;
- four filesystem events delivered over 0.4 seconds repeatedly reset the
  two-second quiet period, produced one reindex, and advanced the ledger from
  four runs to five;
- three TypeScript source rebuilds each reused the Rust shard with zero Rust
  output bytes, while a following unchanged manual reindex reused both
  language shards in 54 ms;
- the default daemon persisted an idle deadline exactly 180,000 ms after its
  last activity; and
- the per-language ledger contained one row per top-level language per run,
  with no TypeScript project-shard duplication.

The first foreground worker probe was deliberately run inside a restricted
process sandbox and the ownership guard refused to spawn because it could not
establish OS process identity. The same probe with normal process-table access
completed. This is the intended fail-closed boundary, not a watcher crash in
the supported execution environment.

The original 24-hour snapshot was 131 runs, 63 rebuilds (48.1%), 68 reuses,
and approximately 4.1 GiB of estimated writes. The closure snapshot is 168
runs, 80 rebuilds (47.6%), 88 reuses, 5,603,147,184 estimated write bytes,
1,062,399,215 reflinked staging bytes, and 187,276,204 fallback-copied bytes.
Those totals are not a steady-state before/after experiment: the rolling
window contains this implementation session's explicit reindexes and
automatic refreshes from ongoing source edits. The full suite and live probes
used isolated caches and did not enter this repository's ledger. The
deployable conclusion rests on those isolated admission/reuse probes;
operational reduction must be read from a new 24-hour window after the
development runs age out.

The globally linked `scip-query@0.20.0` now resolves to this checkout, and the
pre-change watcher was stopped and replaced by the verified build. Its live
deadline confirms the three-minute default. Language attribution is currently
partial because 165 retained records predate Slice 7; they remain valid
aggregate budget evidence and will age out naturally. Final merged SCIP,
SQLite, and staging bytes intentionally remain project aggregates.

Final diff-gate has one knowingly accepted co-change finding:
`tests/reindex/reindex-reliability.test.ts` changed without
`src/reindex/index.ts`. The closure change is Prettier-only; its associated
language-reuse implementation already landed in Slice 6 at `4ffa24b6`, and
the unchanged behavior passes both the full suite and the focused 40-test
reindex reliability suite. No permanent suppression was added because the
test/implementation coupling is useful for future behavioral edits.

### Slice 9 — Passive-safe shared-cache publication

Deployable: yes.

Discovery: the first live probe after committing Slice 8 exposed a second,
independent source of disk amplification. `watch --status` processes remained
alive for more than a minute even though watcher auto-start was disabled.
Process samples placed both status callers and the watcher reindex worker in
`node::fs::CopyFile`, `fsync`, `open`, and `chmod`. The CLI had correctly
stopped starting watchers for passive commands, but its separate shared-cache
preflight still classified `status`, `watch`, `doctor`, `effectiveness`,
`install-skills`, and `reindex` as preparation-eligible. A new commit changes
the Git tree identity, so a fresh local index no longer matched the previous
shared generation. Every eligible command then attempted to publish the full
local cache before doing its actual work.

The publication boundary had a second defect: the build lock serializes
index construction, but direct publication and peer import did not own a
distinct publication lock. Multiple processes could therefore stage, clone,
hash, and durably flush the same immutable generation concurrently. The final
rename handled the race correctly for integrity, but only after every contender
had already paid nearly all of the write cost.

Change:

- exclude passive/lifecycle commands and explicit `reindex` from CLI
  shared-cache preparation; reindex already owns build, hydration, and
  publication inside its command implementation;
- return immediately when an ordinary graph command already has a fresh local
  index instead of hashing artifacts, touching a lease, and publishing a new
  shared generation as command preflight;
- retain shared-cache preparation for graph commands whose local index is
  missing or stale, so exact committed generations can still hydrate a
  worktree without rebuilding;
- place a token-owned, generation-specific `.publish.lock` around validation,
  staging, hashing, rename, and directory synchronization;
- fail a publication contender immediately while an owner is active. Reindex
  treats publication failure as non-fatal because the private local index is
  already valid; a later command may use the completed immutable generation.

Files: `src/runtime/cli-context.ts`,
`src/reindex/shared-generation-store.ts`, focused runtime/shared-generation
tests, and this plan.

Validation: command-classification tests prove graph queries remain eligible
and passive/reindex commands do not; a reentrant fault probe proves a nested
publisher cannot enter staging while the owner completes normally; focused
tests, full static checks, and a live concurrent `watch --status` probe must
all pass. The live probe must complete promptly, leave no status process
behind, and produce no watcher ownership file.

Commit: `fix: serialize shared cache publication`.

Result: **complete.** Five CLI-context tests prove that graph commands remain
preparation-eligible, lifecycle/passive/explicit-reindex commands are not, a
fresh local index returns without publication, and the dirty-watcher shortcut
does not rebuild the project fingerprint. Twenty shared-generation tests prove
the crash boundaries still hold and that a nested publisher fails before
entering staging while its owner publishes a valid immutable generation.

The full suite passes at 272 files / 2,183 tests with two intentional skips
when run with normal process visibility and an isolated cache root. Typecheck,
formatting, ESLint, build, public-API compatibility, public-consumer
typechecking, and skill-link validation pass. The first restricted full-suite
run produced 11 cache-permission failures and five process-identity/reaping
failures; the equivalent normal-visibility run proves these were execution
sandbox constraints rather than product defects.

The globally linked `scip-query@0.20.0` resolves directly to this checkout.
One cold `watch --status` completed in 0.50 seconds including process startup;
four simultaneous calls completed in 40-48 ms each, all reported `stopped`,
and a following JSON status call completed in 37 ms with zero refresh
requests. No watcher, status, or reindex worker remained for this repository.
The only persistent scip-query watcher belonged to the unrelated
`arxiv-agent-cli` repository.

Current-index postchecks found no scoped recent reimplementation and no
incomplete migration. Diff-gate passed with two advisory configuration-example
citations. Both were inspected: the evidence-cache document still correctly
names the shared-generation implementation and its tests, and the target
architecture document still correctly lists the file as an architecture
evidence command. Neither claim changed, so no doc churn or permanent
suppression was added.

## Dependency and Execution Order

Slices 1 and 2 are independent admission filters and land first because they
eliminate whole watcher/rebuild lifecycles. Slice 3 reduces first-run burst
frequency. Slices 4 and 5 bound lifetime and sustained work independently and
may be reverted separately. Slice 6 depends on Slice 2's canonical input
taxonomy but not on timing or budgets. Slice 7 follows Slice 6 so its first
measurement describes the final shard policy. Slice 8 closes the planned
program. Slice 9 is a corrective slice found by closure testing: it depends on
no timing policy, but is required for the program's disk-lightness claim.

## Attack Record

**A1 — I1, behavior.** A user runs `status` in a configured repo with no
daemon. Outcome: HOLE — repaired by Slice 1; status reports stopped state
without creating it.

**A2 — I1, regression.** A new graph command is accidentally classified
passive. Outcome: HELD by Slice 1 descriptor-coverage tests and representative
positive graph-command tests. The policy remains negative/exclusion-based, so
new commands default toward freshness.

**A3 — I2, false invalidation.** Claude writes `HEY.md` or a suppression event.
Outcome: HOLE — repaired by Slice 2's canonical `other` classification.

**A4 — I2, missed input.** A `.d.ts` file changes. Outcome: HELD by the
existing `ambient` classification, included as relevant in Slice 2 tests.

**A5 — I2, directory ordering.** Chokidar emits `addDir` before `add`.
Outcome: HELD: Slice 2 ignores the directory and the contained file event
carries the exact path; deletion tests prove `unlink` remains relevant.

**A6 — I3, evidence failure.** Git metadata changes but the diff command fails
because the prior commit was collected or the repo is mid-operation. Outcome:
HELD by conservative scheduling on unavailable comparison evidence.

**A7 — I3, docs commit.** Committing a Markdown-only change rewrites the Git
index. Outcome: HOLE — repaired by Slice 2 filtering the changed path set
rather than index mtime alone.

**A8 — I4, concurrency.** A new event arrives as the debounce timer fires.
Outcome: HELD by JavaScript's serialized callback execution: either the event
clears the still-owned timer first or it marks the in-flight run dirty. Existing
single-flight/cooldown logic bounds the trailing run.

**A9 — I4, shutdown.** Shutdown begins with a two-second timer pending.
Outcome: HELD by the existing timer owner/clear path and Slice 3 regression.

**A10 — I5, restart bypass.** The user restarts after two rebuilds. Outcome:
HELD by the persisted activity ledger implemented in the predecessor program;
Slice 5 changes constants, not authority.

**A11 — I5, urgent freshness.** The budget pauses an urgent explicit request.
Outcome: HELD: manual `reindex` remains outside automatic admission and its
cost is recorded afterward.

**A12 — I6, cross-language lockfile.** `package-lock.json` changes in a
TypeScript+Rust repo. Outcome: HOLE — repaired by Slice 6 invalidating
TypeScript/JavaScript but reusing Rust.

**A13 — I6, global config.** `.scipquery.json` changes selected languages or
indexer options. Outcome: HELD by retaining it in every language fingerprint.

**A14 — I6, unknown indexer dependency.** A third-party indexer reads a file
not in its declared marker/config/source set. Outcome: HOLE — accepted with
containment. The language policy table must be based on indexer command
contracts and tests; users can still request manual reindex. Any verified
additional input is added to that language's table, not restored globally.

**A15 — I7, double counting.** TypeScript workspace project diagnostics and
the top-level language diagnostic name the same bytes. Outcome: repaired by
Slice 7 persisting only top-level language rows.

**A16 — I7, false physical precision.** APFS compression/clones make logical
artifact bytes differ from device writes. Outcome: HELD by field names and
documentation reporting produced/logical/fallback-copy bytes, never measured
physical device bytes.

## Coverage Matrix

| Surface / writer       | Concurrency               | Failure                 | Integrity               | Observability       | Efficiency | Testability         |
| ---------------------- | ------------------------- | ----------------------- | ----------------------- | ------------------- | ---------- | ------------------- |
| CLI auto-start policy  | A1, A2                    | A2                      | A2                      | Slice 1 probes      | A1         | pure table          |
| Chokidar input handler | A5, A8, A9                | A5                      | A3-A5                   | Slice 2 counters    | A3         | fake subscription   |
| Git poll handler       | A8                        | A6                      | A6, A7                  | changed-path reason | A7         | injected Git reader |
| debounce timer         | A8, A9                    | A9                      | A8                      | waiting deadline    | Slice 3    | fake clock          |
| idle deadline          | existing state machine    | shutdown tests          | active-state exclusions | status deadline     | Slice 4    | fake clock          |
| activity budget        | existing single-flight    | malformed ledger tests  | A10, A11                | paused evidence     | Slice 5    | pure evaluator      |
| language fingerprint   | shard lock/atomic publish | A14                     | A12-A14                 | miss reason         | Slice 6    | all-language table  |
| activity writer        | settled result only       | old/future record tests | A15, A16                | Slice 7             | Slice 7    | pure aggregation    |

No enforcement window spans commits: each slice changes its policy, consumers,
tests, and documentation together. Slices 3-5 are additive/default changes and
explicit user overrides remain stable.

## Risks and Unknowns

- External indexers do not expose one portable document-level incremental
  protocol. The sound generic unit is the per-language shard. Slice 6 improves
  all supported languages at that unit and does not claim finer incremental
  behavior where the tool cannot supply it.
- Git changed-path comparison adds process work only after cheap metadata
  movement. It must be benchmarked so avoiding a rebuild does not create a
  high-frequency Git subprocess.
- A three-minute idle lifetime can create more daemon starts for commands
  spaced just beyond three minutes. Slice 1 must land first so those starts are
  restricted to commands that can use freshness.
- Existing projects with explicit legacy timing/budget values retain them.
  This repository moves to the new values; future setup uses them. A separate
  migration command would require explicit user authorization and is not
  hidden in watcher startup.
- The 24-hour baseline includes activity from active development and is not a
  controlled benchmark. Slice 8 therefore records deterministic probes as well
  as operational telemetry.

## Verdict

A plan is **PLANNED-COMPLETE** iff every pending-refresh writer is represented
in the coverage matrix, every accepted narrower invalidation has a
fingerprint-level backstop, every slice has an observable validation and commit
boundary, and no accepted metric claims more than it measures.

Result: **PLANNED-COMPLETE** — 16 attacks, 7 holes repaired by named slices,
2 explicit limitations accepted with containment, 0 blank state-authority
rows, and 0 failed premises.
