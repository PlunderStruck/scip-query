# Indexing and operations certification

Date: 2026-07-11

Verdict: **the indexing publication protocol, repository-record lifecycle, and
owned setup/removal transitions are certified; environment probes, source
augmentation, composite setup, profiling coverage, and TLA-to-code claims are
qualified by the evidence they can observe.**

## What this certificate means

An operational answer describes a state transition or a directly observable
artifact: an accepted SQLite generation, a watcher process, a config or
suppression file, an installed owned link, a checker process result, or a TLA
model-checker result. What distinguishes it from a detector verdict is that its
truth is established by the resulting files, process state, database identity,
or subprocess exit and diagnostics, rather than by judging a recommendation.

“Certified” below means that the command's stated transition is atomic,
idempotent where promised, and covered by positive and failure-path probes.
“Qualified” means that the observed transition is correct but cannot establish
facts outside its input: an unavailable binary, uninstrumented work, source
facts the augmenter does not model, or runtime behavior absent from a TLA
mapping.

## Reproducible evidence

The broad operational replay ran 64 test files and 532 tests, all passing. A
smaller pre-change selection ran 30 files and 332 tests. Together they covered:

- fail-closed mixed-language indexing, cached language and TypeScript-project
  shards, add/modify/delete classification, repeated affected-document edits,
  corrupt/missing fragments, and full-conversion fallback;
- atomic SQLite publication, an old reader retaining the old inode while new
  readers see the new generation, retained recovery generations, malformed
  state classification, injected transaction/conversion/promotion failures,
  and repair from cached shards;
- manual/watcher lock ownership, concurrent refresh refusal, startup refresh,
  Git HEAD/index polling, idle shutdown, stale-service replacement, command
  wake-up, and stop cleanup;
- setup freshness settling, invalid-config refusal, explicit indexing opt-out,
  missing-indexer consent, service-start failure, setup smoke results, and
  clean owned uninstall;
- checkout-local Codex and Claude hooks, Git exclude entries, idempotent agent
  guidance, CI workflow generation, owned skill-link pruning, and preservation
  of user hooks and non-owned links;
- one-JSON-file-per-suppression persistence, schema rejection, expiration
  warnings, and repository ledger transitions for caught, resolved,
  suppressed, and reopened findings;
- exact repeated-work grouping, within-run versus cross-run identity,
  malformed JSONL diagnostics, cold-benchmark restore markers, TLA checker
  dependency/timeout behavior, model-contract mutation probes, and a real TLC
  legal/illegal trace replay.

The live self-repository replay observed:

- 328 indexed files and 22,318 symbols;
- a cold TypeScript+Rust rebuild in 4,350 ms, the following warm index in 357
  ms, and `stats --json` in 156 ms;
- a fresh index, current SQLite generation, running demand-started daemon with
  an idle watcher, and ready TypeScript semantic and incremental-index sessions;
- exact `result` parity between `capabilities --json` and
  `capability-matrix --json` (their envelope command names intentionally
  differ); and
- a two-event profile with no instrumented spans, which `work-audit` correctly
  reported as zero identified/repeated work instead of inventing coverage.

These timings characterize this checkout and machine; they are measurements,
not performance promises for other repositories.

The affected-set protocol represents a filesystem rename as one deleted path
and one added path. Its exact content digests then determine the documents to
remove and emit; it does not depend on Git's heuristic rename score.

## Per-command verdicts

| Command | Verdict | Truth rule and boundary |
| --- | --- | --- |
| `reindex` | certified | publishes only validated complete generations by default; explicit partial mode remains labeled |
| `augment-sources` | qualified | adds registered auxiliary source facts without overwriting indexed documents; unsupported source identities remain absent |
| `watch` | certified | owns one observable per-project service lifecycle, coalesces refreshes, wakes on demand, and exits only from clean idle |
| `status` | certified | reports the configured/current artifact, freshness fingerprint, generation, service, and index counts observed at the call |
| `work-audit` | qualified | exact identity and avoidable-time arithmetic for instrumented profile events; uninstrumented work is not claimed |
| `bench` | certified | reports measured subprocess duration, exit, timeout, bytes, and cold-cache restore outcome for this environment |
| `capabilities` | qualified | reports detected language/tool/runtime evidence and visible unavailable/partial states; it is not detector certification |
| `capability-matrix` | parity | identical capability result payload to `capabilities`; only the command envelope name differs |
| `doctor` | qualified | faithfully aggregates config, dependency, freshness, generation, service, and capability probes; it cannot diagnose unmodeled failures |
| `check-deps` | qualified | reports detected/runnable SCIP, indexer, and semantic dependencies at probe time, not future availability |
| `config-validate` | certified | deterministic schema/path/expiration diagnostics without changing the project |
| `suppress` | certified | validates a reason and stable identity, then writes one reviewable repository JSON record |
| `init` | certified | creates the owned project config without overwriting an existing configuration |
| `setup` | qualified | orchestrates explicit choices and reports partial/blocking steps; external package installation and service availability remain environmental |
| `setup-agent` | certified | idempotently manages only the delimited repository guidance block and optional owned Git hook |
| `setup-hooks` | certified | manages checkout-local hook files and local opt-out state while preserving user hooks |
| `setup-ci` | certified | deterministically renders/writes the owned GitHub Actions workflow and refuses overwrite without force |
| `uninstall` | certified | removes only owned setup artifacts and explicitly preserves shared suppression/effectiveness records |
| `install-skills` | certified | creates/prunes only scip-query-owned skill links and preserves non-owned entries |
| `tla` | qualified | checker/scaffold/instrument/trace transitions and mapped conformance facts are reproducible; unmapped runtime behavior is not proved |

## Defect found and corrected

The capability matrix treated Python's `compileall` fallback as full compiler
cleanup verification. `compileall` proves only that Python files still parse;
it does not report a deleted name used elsewhere. Checkers now carry an
explicit verification strength. Syntax-only coverage is `partial`,
reference-aware checkers are `available`, and the project-level result is
aggregated across every detected language. The correction propagates through
`status`, `doctor`, `capabilities`, setup diagnostics, agent hooks, and health.

The capability evidence kind and label now say “checker” and “Project cleanup
verification,” avoiding the false implication that every supported verifier is
a compiler. A regression plants a mixed TypeScript/Python project and requires
available TypeScript, partial Python, and partial project-level verification.

## Local preferences and repository records

The setup audit verified the ownership boundary:

- `.codex/hooks.json` and `.claude/settings.local.json` are checkout-local
  user/tool preferences, installed with Git exclude entries and not committed;
- `.scipquery/suppressions/*.json`, `.scipquery/ledger/events.jsonl`, and
  `.scipquery/ledger/.gitattributes` are shared repository records, preserved
  by uninstall and committed with the change that produced them; and
- setup/agent/CI configuration is committed only where the command explicitly
  creates a project-owned shared artifact.

The ledger probes establish caught→resolved, caught→suppressed,
suppressed→reopened, deduplication, malformed-line tolerance, and deterministic
effectiveness aggregation. A finding does not become “fixed” merely because a
command stopped running; a later gate observation must record its resolution.

## Publication decision

The certified transitions and qualified observed-state views are ready for a
private cloud shadow. A cloud runner must preserve the repository commit,
scip-query version, configuration, capability report, accepted index generation,
and raw command output for every run. Public leaderboard operation remains a
separate product program, and the aggregate health score remains non-comparable
across languages.

Machine-readable verdicts:
[`2026-07-11-indexing-operations-certification-verdicts.json`](./2026-07-11-indexing-operations-certification-verdicts.json).
