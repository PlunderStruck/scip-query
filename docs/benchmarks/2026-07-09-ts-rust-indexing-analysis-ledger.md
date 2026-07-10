# TypeScript and Rust Indexing/Analysis Ledger

Date: 2026-07-09

## Output Contract

Optimization is accepted only when command output hashes remain identical, or
when an accuracy correction is documented before accepting the change.

An indexing optimization must leave `status --capabilities` correct for the
project and must not let complete and partial indexes share cache identity. A
semantic-analysis optimization must preserve the same compiler-backed facts for
TypeScript and Rust: references, caller files, callees, signatures, and import
usage where supported.

## Representative Corpora

| Corpus          | Role                                                | Notes                                                                                                                                               |
| --------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| scip-query      | local mixed TypeScript/Rust development corpus      | Fresh index after `node dist/cli.js reindex`: 293 files, 18,494 symbols.                                                                            |
| VegaAssistant   | mixed app corpus from previous full-pass speed work | Used for large mixed TS/Rust command hashes.                                                                                                        |
| codex-rs        | Rust-heavy corpus                                   | Partial index is expected when C indexing fails; Rust/TS/Python shards are still usable for Rust-heavy profiling.                                   |
| SynthRunnerRust | standalone Rust corpus                              | Fresh Rust-only index; used after codex-rs proved unsuitable for clean hash comparison because the mixed parent stayed stale after partial reindex. |

## Current Candidate Areas

### Semantic Reference Cache Scans

`materializeSemanticReferenceBatch()` currently groups definitions by file but
calls `readCachedSemanticReferencesForFile()` once per file. On large full-mode
runs, `semantic.references.cache-scan` still appears in the top spans. This
candidate benefits both TypeScript and Rust because semantic reference cache
rows are language-neutral.

Acceptance signal:

- exact output hashes on representative commands;
- lower `semantic.references.cache-scan` total on at least one large corpus;
- no increase in semantic miss/parse-failure counts.

Outcome: rejected for now. Multi-file reference batching was hash-identical on
VegaAssistant, but it did not improve the command or profile span:

| Run                                                               | Wall time | `semantic.references.cache-scan` | Hash                                                               |
| ----------------------------------------------------------------- | --------: | -------------------------------: | ------------------------------------------------------------------ |
| VegaAssistant baseline `health --full --json`                     |   10.259s |                           3.827s | `1bed3b9ffbe72061bf9bebd095da78abcde3e6b841bab0faee6617a9dd6fa81b` |
| VegaAssistant after reference batch, health cache cleared         |    9.973s |                           4.088s | same                                                               |
| VegaAssistant after tuple/callee experiment, health cache cleared |   10.414s |                     not accepted | same                                                               |

The callee tuple-batch experiment was rejected harder: on the mixed codex-rs
parent, the project was stale after partial reindex and semantic cache keys did
not match; the attempted run timed out. The implementation was reverted to the
known per-file prepared statement path.

### Cold Versus Warm Rust Semantics

The Rust-heavy optimization target is warm-state durability, not merely faster
SQLite cache reads. SynthRunnerRust is a fresh Rust-only corpus:

| Run                                                      | Wall time | Hash                                                               | Notes                                                                                                                                   |
| -------------------------------------------------------- | --------: | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `reindex --json`                                         |   31.000s | n/a                                                                | Rust-only SCIP shard built cleanly.                                                                                                     |
| cold `health --full --json`, health cache cleared        |   58.363s | `fb798702350d01c5a72267e1bf31d224f5ee814dfe2a802ef594ce55a809eb54` | Populated semantic evidence.                                                                                                            |
| warm `health --full --json`, health cache cleared        |    0.966s | `7a380714264677105decca5e2a4d4ac3bd53add0fa17883d90431820775e3b5a` | First warm run after evidence writes; one-byte output state transition from cold.                                                       |
| warm repeat `health --full --json`, health cache cleared |    0.999s | `7a380714264677105decca5e2a4d4ac3bd53add0fa17883d90431820775e3b5a` | Stable warm output hash.                                                                                                                |
| semantic-prewarm production-only cold                    |   59.138s | `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348` | Rejected boundary: parent warmed 1,045 production callables, but workers still computed 7 reference and 616 callee misses.              |
| semantic-prewarm all-definitions cold                    |   45.450s | `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348` | Accepted boundary: parent warmed 1,661 semantic-supported definitions before phase workers.                                             |
| semantic-prewarm all-definitions marker hit              |    0.900s | `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348` | Health cache cleared; project prewarm marker hit in 1ms, workers read warmed rows.                                                      |
| Rust first-fill split profile, default repeat            |   47.843s | `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348` | Added worker-level spans and indexed callee symbol resolver; hash-identical control for the next tuning experiments.                    |
| Rust first-fill marker hit after split profile           |    0.851s | `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348` | Health cache cleared; project prewarm marker still skips and workers stay cache-only.                                                   |
| Rust first-fill zero diagnostics + zero settle           |   21.928s | `c3c3847bf84219f57dc38061a8f36e075262d7996f93bedbae559a9987654de5` | Rejected: fast only because semantic references collapsed from about 3,011 facts to 13 facts.                                           |
| Rust first-fill settle-only zero                         |   47.450s | `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348` | Safe on SynthRunnerRust, but only 0.393s faster than paired default repeat; keep as explicit env experiment, not default.               |
| Rust reference drilldown profile                         |   44.907s | `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348` | Added per-file and slow-task profile events; exposed repeated Rust `impl Default` methods resolving to the wrong fallback position.     |
| Rust impl-owner range correction                         |   45.413s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` | Accepted accuracy correction: Rust reference facts rose from 3,011 to 3,048 and repeated impl methods now resolve to their owner block. |
| Rust request timeout 5s experiment                       |   48.213s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` | Rejected: health hash stayed the same, but semantic reference facts dropped from 3,048 to 2,927.                                        |

Profile totals:

| Profile                                      |                                         References |                                            Callees | Key observation                                                                       |
| -------------------------------------------- | -------------------------------------------------: | -------------------------------------------------: | ------------------------------------------------------------------------------------- |
| SynthRunnerRust cold                         |                                0 hits / 474 misses |                            807 hits / 2,696 misses | Compiler-backed semantic materialization dominated the run.                           |
| SynthRunnerRust warm repeat                  |                                474 hits / 0 misses |                              3,503 hits / 0 misses | With durable semantic rows warm, full health is sub-second.                           |
| SynthRunnerRust prewarm all-definitions cold | 0 hits / 1,661 misses in parent; workers 100% hits | 0 hits / 1,661 misses in parent; workers 100% hits | Parent prewarm removes worker recomputation; cold cost is now one Rust semantic fill. |
| SynthRunnerRust prewarm marker hit           |                  1ms marker hit; workers 100% hits |                  1ms marker hit; workers 100% hits | Durable across health-cache clears and process restarts.                              |

Decision: full-health semantic prewarming is the production path. It runs once
before phase workers when project semantic evidence is cold, writes a durable
project marker after reference and callee cache materialization, and skips
cheaply when the marker matches the current project fingerprint. The next
Rust-specific target is the 33.109s parent `semantic.references.compute-misses`
span inside the first cold fill.

### Rust First-Fill Session Split

The first Rust first-fill slice added worker-level profile spans around the
persistent rust-analyzer session. A profile span is a timed section of the
running process; these spans are useful because they separate rust-analyzer
work from local TypeScript wrapper work.

Default paired control on SynthRunnerRust:

| Span                                             | Duration | Facts/counts                                             |
| ------------------------------------------------ | -------: | -------------------------------------------------------- |
| `health.semantic-prewarm`                        |  46.567s | 1,661 definitions                                        |
| `semantic.references.provider-loop`              |  35.427s | 632 definitions with references, 3,011 reference facts   |
| `rust.semantic.worker.open-definition-documents` |  10.741s | 26 opened Rust documents                                 |
| `rust.semantic.worker.diagnostics`               |   5.733s | waited for diagnostics on 26 documents                   |
| `rust.semantic.worker.settle`                    |   5.002s | fixed settle delay                                       |
| `rust.semantic.worker.references`                |  21.872s | 1,661 reference requests at concurrency 8                |
| `semantic.callees.provider-loop`                 |   5.097s | 539 definitions with callees, 2,561 callee facts         |
| `rust.semantic.worker.callees`                   |   0.226s | rust-analyzer call hierarchy itself                      |
| `rust.semantic.callees.complete-map`             |   2.313s | local mapping of rust-analyzer callee names to SCIP rows |

Decisions from the split:

- Keep the worker-level spans; they exposed that Rust references, diagnostics
  readiness, and local callee symbol normalization are separate costs.
- Keep the provider-scoped Rust callee symbol resolver index. It preserves the
  existing mapping behavior and avoids per-callee file/name scans, though this
  corpus shows only a small total win because definition-catalog reads and
  rust-analyzer references dominate.
- Keep `SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS=0` and
  `SCIP_RUST_SEMANTIC_SETTLE_MS=0` as real non-negative knobs for experiments.
  Do not make either zero by default from this data.
- Reject zero diagnostics for production. On SynthRunnerRust it changed the
  output hash and reduced reference facts from about 3,011 to 13.
- Do not default settle to zero yet. It was hash-identical and slightly faster
  in one paired run, but the gain was within run-to-run noise while references
  slowed enough to absorb most of the removed 5s sleep.
- Keep the Rust reference drilldown profile events. The per-file rollup showed
  `src/app.rs`, `src/effects.rs`, `src/diagnostics.rs`, `src/config.rs`, and
  `src/camera.rs` dominated reference task time on SynthRunnerRust.
- Accept the Rust impl-owner range correction as an accuracy fix. A repeated
  method name such as `default` is not enough to identify a Rust definition when
  fallback chunks contain several `impl Default` blocks; the SCIP owner segment
  must participate in range correction.
- Reject a 5s Rust semantic request timeout as a default. It preserved this
  health report hash but lost 121 compiler-backed reference facts, which is a
  semantic regression.

### Rust Default Impl Reference Fast Path

The next accepted Rust slice uses SCIP mention chunks as the compiler-resolved
identity source for `impl Default::default` references, then scans only those
chunks for exact direct `Owner::default` columns. Ambiguous `Default::default`
syntax or chunks without a direct owner call fall back to rust-analyzer.

SynthRunnerRust cold run with semantic reference cache and health report cache
cleared:

| Span                                | Duration | Facts/counts                                                |
| ----------------------------------- | -------: | ----------------------------------------------------------- |
| `health.semantic-prewarm`           |  18.902s | 1,661 definitions, 1,661 reference cache writes             |
| `semantic.references.provider-loop` |  16.235s | 16 fast-path rows, 167 fast-path refs, 3,118 total refs     |
| `rust.semantic.worker.references`   |   2.896s | 1,645 LSP reference requests, 2,951 refs from rust-analyzer |

Decision: accepted. Compared with the impl-owner range baseline, cold full
health fell from 45.413s to 19.822s. Semantic references rose from 3,048 to
3,118 because the chunk-refined direct-default path recovered 70 direct
`Owner::default` references that rust-analyzer had timed out or missed.

Rejected follow-up: `SCIP_RUST_SEMANTIC_SETTLE_MS=0` after the Default fast
path preserved the same hash and 3,118 reference facts, but did not improve wall
time: 19.961s versus 19.822s. The profile moved 5.002s out of
`rust.semantic.worker.settle`, but `rust.semantic.worker.references` grew from
2.896s to 7.999s, so the default 5s settle remains.

### Rust SCIP Occurrence Reference Fast Path

`index.scip` contains exact occurrence positions. A comparison against the
accepted SynthRunnerRust semantic cache showed that broad SCIP occurrences are
too noisy for fields, types, and modules, but safe Rust function/value-like
symbols were effectively exact. The accepted implementation uses SCIP
occurrences only for Rust method symbols and top-level term symbols, while
continuing to fall back to rust-analyzer for fields, types, modules, trait impl
members, and `Default::default` impls.

SynthRunnerRust full cold run with semantic references, semantic callees, the
health prewarm marker, and the health report cache cleared:

| Span                                | Duration | Facts/counts                                                     |
| ----------------------------------- | -------: | ---------------------------------------------------------------- |
| `health.semantic-prewarm`           |  19.789s | 1,661 definitions, 1,661 reference cache writes, 540 callee rows |
| `semantic.references.provider-loop` |  13.436s | 906 SCIP fast-path rows, 2,773 SCIP refs, 3,117 total refs       |
| `rust.semantic.worker.references`   |   1.607s | 739 LSP reference requests, 177 refs from rust-analyzer          |
| `semantic.callees.provider-loop`    |   2.395s | 1,661 callee requests, 2,564 callees                             |

Decision: accepted. Full cold health improved from 24.352s after the Default
fast path to 21.210s. The health JSON hash stayed
`4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a`.
Semantic references changed from 3,118 to 3,117 because one previously cached
symbol, `diagnostics/record_fixed_steps().`, was corrected from four same-name
method references to three free-function call sites.

Rejected readiness follow-ups after the SCIP occurrence fast path:

- `SCIP_RUST_SEMANTIC_SETTLE_MS=0`: 21.630s, same health hash and same 3,117
  reference facts, but slower because `rust.semantic.worker.references` grew to
  7.559s.
- `SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS=0`: 21.530s, same health hash and
  same 3,117 reference facts, but slower because references grew to 8.366s.
- `SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS=0 SCIP_RUST_SEMANTIC_SETTLE_MS=0`:
  16.140s, rejected for accuracy loss. It dropped semantic references from
  3,117 to 2,953, callee facts from 2,564 to 2,415, and changed the health hash
  to `bc282574c33f29b70db99e30e13ea0e39ee17aeed9a4c50363cd89b8bee1a9e6`.

### Rust Provider Status Cache

Accepted change: cache the base Rust Analyzer availability inside each Rust
semantic provider instance. `availableSemanticProvider()` asks availability for
each definition during bulk semantic materialization; before this change those
checks repeatedly re-resolved the Rust indexer dependency.

SynthRunnerRust cold `health --full --json`, semantic references/callees/health
cache cleared:

| Slice                                 |    Time | Health hash                                                        | Ref facts | Callee facts |
| ------------------------------------- | ------: | ------------------------------------------------------------------ | --------: | -----------: |
| SCIP occurrence fast path accepted    | 21.210s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` |     3,117 |        2,564 |
| Callee-capable filter only            | 22.010s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` |     3,117 |        2,564 |
| Provider status cache + callee filter | 14.940s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` |     3,117 |        2,564 |

Profile deltas:

| Span                                |          Before |   After | Note                                     |
| ----------------------------------- | --------------: | ------: | ---------------------------------------- |
| `health.semantic-prewarm`           | 19.789s-21.164s | 14.101s | same facts, same hash                    |
| `semantic.callees.provider-loop`    |          2.395s |  0.368s | per-definition availability probing gone |
| `rust.semantic.worker.callees`      |          0.342s |  0.347s | Rust Analyzer work unchanged             |
| `semantic.references.provider-loop` |         13.436s | 13.613s | reference LSP readiness remains dominant |

Decision: accepted. This is an accuracy-preserving local hot-path fix. The
next Rust semantic speed lever is still the reference request path: 739
remaining Rust Analyzer reference requests and the diagnostics/settle readiness
window dominate first-fill time.

Follow-up accepted on the same slice: the health semantic prewarm marker now
includes a semantic engine fingerprint. Before this, a project-level warm marker
could skip prewarm after changing an engine-level reference mode even though the
underlying semantic reference cache key would miss. Default safe-mode
SynthRunnerRust cold `health --full --json` after this marker fix measured
14.820s with the same health hash, 3,117 references, and 2,564 callees.

Rejected/diagnostic occurrence-mode follow-up:

- `SCIP_RUST_SCIP_OCCURRENCE_REFERENCE_MODE=all`: 25.850s, same health hash, but
  semantic reference facts jumped from 3,117 to 12,575 and the run was slower.
  Keep this as an explicit experiment/comparison mode only. Its mode is included
  in the Rust semantic reference cache identity so experimental payloads cannot
  pollute default safe-mode cache entries.
- Re-run after provider status cache and marker fix: 18.640s, same health hash,
  still 12,575 semantic reference facts, and still slower than default safe mode.
  The run avoided most reference requests but then paid Rust Analyzer readiness
  during the callee pass because the reference pass opened only one document.
- Rejected broad zero-reference shortcut: for 50 Rust definitions with zero SCIP
  occurrence references outside the accepted safe fast path, a direct
  rust-analyzer audit still found three references across two module symbols.
  Therefore "SCIP has no occurrence references" is not a safe default proof of
  zero references.
- Rejected broad fallback-class promotion after the current indexing slices:
  SynthRunnerRust still had only 81 exact rows out of 755 fallback definitions
  when comparing cached rust-analyzer rows to SCIP occurrences, and scip-query
  itself had only 1 exact row out of 36 fallback definitions. On scip-query,
  type-owned Rust terms, type symbols, and most namespace symbols had zero
  compiler-backed references but 159 SCIP-only references. No additional
  fallback symbol class is safe to promote until a narrower source refinement
  can prove exact parity.

### Small Rust Reference Batch Settle Policy

Follow-up profile on the mixed scip-query repo showed a different shape than
SynthRunnerRust: only 36 Rust definitions needed rust-analyzer reference
fallback, they opened two Rust documents, and they returned zero references.
The fixed 5s settle delay dominated that small request while TypeScript semantic
reference scanning stayed under a second.

| Corpus          | Mode                                       | Wall time | Hash                                                               | References | Callees | Key span                                                                |
| --------------- | ------------------------------------------ | --------: | ------------------------------------------------------------------ | ---------: | ------: | ----------------------------------------------------------------------- |
| scip-query      | forced `SCIP_RUST_SEMANTIC_SETTLE_MS=5000` |   10.467s | `35b0f7504cb98a59037696923458ef42721e12b3e4af7ccbc6f95034029e4730` |     16,379 |   3,097 | `health.semantic-prewarm` 8.728s; Rust settle 5.000s                    |
| scip-query      | adaptive default                           |    5.165s | `35b0f7504cb98a59037696923458ef42721e12b3e4af7ccbc6f95034029e4730` |     16,379 |   3,097 | `health.semantic-prewarm` 3.399s; Rust settle 0ms                       |
| SynthRunnerRust | forced `SCIP_RUST_SEMANTIC_SETTLE_MS=5000` |   15.549s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` |      3,117 |   2,564 | 739 Rust fallback reference definitions kept the conservative 5s settle |
| SynthRunnerRust | adaptive default                           |   15.249s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` |      3,117 |   2,564 | Same 739-definition guardrail path, same fact counts                    |

Direct guardrail audit on SynthRunnerRust selected the 41 positive-reference
fallback definitions that were not handled by the Default or safe SCIP
occurrence fast paths. A direct `runRustAnalyzerReferenceBatch` comparison
returned the same 177 references with `settleDelayMs=5000` and `settleDelayMs=0`
(`diffCount=0`), so the small-batch policy is not relying on zero-result-only
behavior.

Rejected diagnostics follow-up: applying both `diagnosticsTimeoutMs=0` and
`settleDelayMs=0` to the same 41 positive fallback definitions returned only 13
references across 7 rows, with 34 symbol-level diffs. Diagnostics readiness is
therefore not optional even for small positive Rust batches.

Decision: accepted. The default settle policy now skips the artificial wait only
for reference-only Rust semantic batches with 64 or fewer definitions. Larger
reference batches, callee batches, signature batches, and Rust import-definition
lookups keep the conservative 5s default. Explicit
`SCIP_RUST_SEMANTIC_SETTLE_MS` values still override the adaptive default.

### Small Combined Rust Settle Follow-up

Combined Rust semantic materialization is the path that asks one rust-analyzer
project session for references and callees together, instead of opening the
same project twice. After that path landed, scip-query's mixed full-health
prewarm issued one small combined Rust request: 76 Rust definitions across two
documents. The request still paid the old fixed 5s settle wait.

Fresh paired measurements on the current worktree:

| Run                                        | Wall time | Hash                                                               | `health.semantic-prewarm` | Rust session | Rust settle | Semantic rows              |
| ------------------------------------------ | --------: | ------------------------------------------------------------------ | ------------------------: | -----------: | ----------: | -------------------------- |
| forced `SCIP_RUST_SEMANTIC_SETTLE_MS=5000` |   15.756s | `ddd488b34533ca771b5d2678d086ec4191469fcb879456298c7ec9d4ca4c3aed` |                   11.869s |       6.911s |      5.003s | 4,521 refs / 4,522 callees |
| adaptive default                           |   11.200s | same                                                               |                    7.339s |       2.414s |      0.000s | 4,521 refs / 4,522 callees |

Decision: accepted. The adaptive policy now has two explicit boundaries: small
reference-only batches skip settle at 64 or fewer definitions, and small
combined reference+callee batches skip settle at 96 or fewer definitions when
signatures are not included. Explicit env overrides still win, and large
Rust-heavy combined batches keep the conservative 5s default. This preserves
the full health output hash and durable semantic row counts while removing a
fixed wait from the mixed scip-query path.

### No-Prewarm Worker Demand Experiment

Rejected experiment: disabling full-health semantic prewarm is not a safe speed
path. An initial SynthRunnerRust `evidence-cold` run reported 0.142s only
because the health-report cache was still warm, which exposed a benchmark
harness bug. After clearing `health-report-cache.json`, the same no-prewarm run
took 31.639s, changed the health JSON hash from
`4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` to
`b1de1b45bd3fbb7a49248fb5c4707ad52c6dc249d247f0b7e7a18ed7517f302a`, and
wrote only 422 semantic reference rows instead of the 1,661 rows written by the
parent prewarm path.

The profile is still useful for future design. Without parent prewarm, workers
asked for 475 semantic reference rows but all 1,661 semantic callee rows, and
they paid repeated Rust Analyzer readiness costs across separate processes.
Therefore the next safe speed frontier is not disabling prewarm. It is either a
parent-side candidate prewarm that preserves the full output contract, or a
durable project-level Rust Analyzer session that avoids reopening and
rewarming the same project across commands.

### Rust Callee Symbol Canonicalization Guard

Callee symbol canonicalization is the local pass that takes a rust-analyzer call
target, such as a short function name and source location, and maps it back to a
project SCIP symbol when the target file is part of the indexed project. An
indexed document is a source file with a row in the SCIP `documents` table.

The current parent-prewarm profile showed `rust.semantic.callees.complete-map`
taking about 2.2s even though rust-analyzer call hierarchy itself took only
about 0.36s. A first resolver-result cache was safe but did not move the span:
the cache-only diagnostic run still measured `complete-map` at 2.209s. The real
cost was asking the definition catalog about dependency files that cannot have
project SCIP symbols.

Accepted fix: the provider-scoped Rust callee symbol resolver now loads the set
of indexed project documents once. If a callee target file is outside that set,
the resolver returns the rust-analyzer symbol unchanged instead of reading and
range-correcting definitions for a non-project path. Exact `(file, symbol,
line)` result caching remains in place for repeated project-local callees.

| Run                                       | Wall time | `semantic.callees.provider-loop` | `rust.semantic.callees.complete-map` | Hash                                                               |
| ----------------------------------------- | --------: | -------------------------------: | -----------------------------------: | ------------------------------------------------------------------ |
| Current parent prewarm after prior slices |   16.896s |                           2.577s |                               2.207s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` |
| Cache-only diagnostic                     |   17.729s |                           2.576s |                               2.209s | same health surface; output was not separately saved               |
| Indexed-document guard accepted           |   14.902s |                           0.370s |                               0.002s | `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a` |

Decision: accepted. This preserves the full semantic health hash and removes a
local mapping tax from Rust-heavy cold first fill. The remaining first-fill
cost is now almost entirely Rust reference readiness: document open,
diagnostics, settle, and 739 fallback reference requests.

Rejected follow-up: forcing `SCIP_RUST_SEMANTIC_SETTLE_MS=0` after the callee
guard preserved the same hash and the same 3,117 reference / 2,564 callee facts,
but measured 15.948s instead of 14.902s. The profile removed the 5.002s settle
span, but `rust.semantic.worker.references` grew from 1.546s to 7.600s, so the
large-batch conservative settle remains the default.

Additional rejected readiness knobs:

| Experiment                          | Wall time | Hash/facts | Key profile result        |
| ----------------------------------- | --------: | ---------- | ------------------------- |
| `SCIP_RUST_SEMANTIC_SETTLE_MS=1000` |   15.906s | same       | references grew to 6.621s |
| `SCIP_RUST_SEMANTIC_SETTLE_MS=3000` |   15.864s | same       | references grew to 4.757s |
| `SCIP_RUST_SEMANTIC_SETTLE_MS=4000` |   16.019s | same       | references grew to 3.801s |
| `SCIP_RUST_SEMANTIC_CONCURRENCY=16` |   15.745s | same       | references grew to 2.559s |

These runs show the 5s settle and concurrency 8 default are not arbitrary
padding on SynthRunnerRust. Lower settle values start reference queries before
rust-analyzer is ready enough, and higher concurrency does not reduce the
remaining reference wall time. The next Rust speed frontier is architectural:
a durable project-level rust-analyzer session that avoids paying document open,
diagnostics, and settle readiness for each cold CLI process.

### Repeat Reindex With Reused Language Shards

`runLanguageIndexersForFreshReindex()` can reuse TypeScript and Rust language
SCIP shards. The publish phase still materializes combined SCIP and converts to
SQLite unless whole-project reuse has already returned early.

Acceptance signal:

- repeat reindex is faster when all requested indexed language shards are
  reusable;
- `status --capabilities` remains correct;
- output DB, SCIP path, metadata, and post-index augmentation remain valid;
- partial-index status remains isolated from complete-index cache identity.

Implementation note: the measured fast path targets non-language changes, such
as benchmark docs, where TypeScript and Rust language SCIP shards are unchanged
but the whole-project fingerprint still needs metadata refresh.

Accepted implementation:

| Run                                                                  | Duration | Result          | Shards                      | Decision |
| -------------------------------------------------------------------- | -------: | --------------- | --------------------------- | -------- |
| Repeat `reindex --json`, old publish path after docs changed         |   1.072s | `reused: false` | TypeScript/Rust both reused | Control  |
| Repeat `reindex --json`, metadata-only path after benchmark doc edit |   0.244s | `reused: true`  | TypeScript/Rust both reused | Accepted |

The accepted path skips combined SCIP materialization and SQLite conversion
only when `skipIfUnchanged` is not explicitly false, no language was skipped,
every requested language output came from a reused shard, and the published
SCIP and SQLite artifacts already exist. It still runs auxiliary-document
augmentation against the existing DB and rewrites metadata with the new
whole-project fingerprint. The measured metadata remained `complete`, kept
requested/indexed languages as TypeScript and Rust, and included the changed
benchmark ledger file in the refreshed fingerprint.

Follow-up accepted as a small consistency improvement: metadata publication now
carries language fingerprints from shard classification instead of hashing the
same per-language inputs again. On this repository the repeat metadata-only
path measured 0.238s, which is in the same noise band as the 0.237s-0.244s
metadata-only runs. The value is mostly removing duplicated work and ensuring
metadata uses the exact fingerprints that made the shard-reuse decision.

### Benchmark Harness Reliability

The benchmark harness previously forwarded a relative `--profile-out` value to
the spawned command unchanged. Because the spawned command runs with `cwd` set
to the target corpus, a relative profile path could land inside the benchmarked
repository rather than beside the intended scip-query run history.

Accepted fix: `scripts/performance-architecture-contract.mjs` now resolves the
profile path to an absolute path before creating directories or spawning the
target command. `tests/scripts/performance-architecture-contract.test.ts`
covers the boundary by passing a relative `--profile-out` and asserting the
child process receives an absolute `SCIP_QUERY_PROFILE_OUT`.

Accepted follow-up: the same harness now clears `health-report-cache.json` for
`evidence-cold` and `cold-index` measurements. This matches the real contract of
those states: a cold semantic/evidence benchmark must not be satisfied by a
previously cached health report.

### Vega Rust Reference Fallback Follow-ups

VegaAssistant cold `__health-phase complexity-hotspots --full` is the current
large mixed TS/Rust stress case for reference and callee first-fill behavior.
The conservative baseline measured 99.790s with output hash
`09cd4241098ea2db6360bb3ba0671647bc526c22d2838372a5eae2dabbb35a73`.
The dominant spans were Rust reference fallback (578 provider-hit definitions,
51.297s provider loop) and Rust callee materialization (7,186 provider-hit
definitions, 39.359s provider loop).

Rejected `SCIP_RUST_SCIP_OCCURRENCE_REFERENCE_MODE=all`: it measured 117.480s,
changed the output hash to
`0c6810dde566fa963445bad9323c5fef970eb34560877da017d5d96075277338`, and did
not reduce the 578 Rust reference provider hits. Broad occurrence promotion is
therefore still not a safe or faster path.

Rejected callee-first ordering: it measured 116.900s and changed the output
hash to the same drifted value. The Rust session still opened definition
documents twice because the reference and callee requests used different
linked-project/session keys. The experiment was reverted.

Rejected ordinary trait-impl occurrence promotion: a direct comparison showed
many Vega ordinary trait impl occurrence rows match rust-analyzer, and one
codex-rs ordinary method spot-check also matched. The full Vega run still
measured 117.180s and changed the output hash. Even though reference provider
hits fell from 578 to 424, health facts changed and the phase was slower, so
this shortcut was reverted. `TraitMethod`/`From`-style spot checks also proved
that SCIP occurrences can disagree with current rust-analyzer output.

Accepted combined reference/callee materialization: the first split-list guard
run preserved the active implementation shape but measured 119.170s with output
hash `0c6810dde566fa963445bad9323c5fef970eb34560877da017d5d96075277338`.
That hash differs from the older 99.790s `09cd...` artifact, so the guard is
not used as a speedup claim against that older baseline. It is used only as the
immediate control for the prefetch hook.

With the complexity phase asking the semantic product to prefetch callees while
materializing references, the same cold Vega phase measured 80.070s with the
same `0c6810...` output hash. The reference provider loop stayed about the
same size, 54.528s to 54.723s, but it now filled 7,186 Rust callee definitions
inside the same rust-analyzer project session. The later callee provider loop
then dropped from 39.785s to 0.007s because it consumed the prefetched provider
results. The single combined Rust session request was 52.796s for 578 reference
definitions and 7,186 callee definitions.

Accepted follow-up: prefetched callee rows now flow into the semantic callee
cache wrapper before the file-by-file cache scan. The wrapper still writes the
normal durable `semantic_callees` rows with source/dependency fingerprints, but
it no longer reads the cache for rows that were just produced by the combined
Rust session. The same Vega phase measured 79.500s with the same `0c6810...`
hash. `semantic.callees.cache-scan` fell from 5.870s to 0ms, and the durable
prefetch cache write took 36ms for 7,186 entries. The command-level gain is only
0.570s because Rust references still dominate the wall clock.

Diagnostic slow-reference profile: enabling
`SCIP_RUST_SEMANTIC_REFERENCE_TASK_PROFILE_MS=5000` showed 15 slow Rust
reference requests, mostly standard trait or extension impl members such as
`From::from`, `Default::default`, `Clone::clone`, `Display::fmt`,
`Error::source`, `Deserialize::deserialize`, and one extension trait method.
The run kept the command hash but produced fewer semantic reference facts
(22,283 instead of the accepted 22,316), so it is not an acceptance baseline.

Diagnostic timeout follow-up: raising `SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS`
to 30,000ms kept the same command hash and restored the accepted 22,316
semantic reference facts, but measured 82.370s. This rejects a tempting
zero-reference shortcut for the slow standard trait impls. The right next
frontier is either a narrow source-assisted parity proof for those trait shapes
or a durable rust-analyzer session/timeout policy that avoids freezing
timeout-shaped empty results.

Rejected direct `From::from` fast path: a conservative source-assisted path for
direct `Owner::from(...)` calls measured 78.770s and kept the `0c6810...`
command hash, but semantic reference facts dropped from 22,316 to 22,314. The
drop did not come from the 12 rows the fast path answered; removing those rows
changed rust-analyzer request scheduling and two
`mentor/distillation_export.rs` `From` impl references timed out. The code was
reverted. This is evidence that the remaining Rust reference bottleneck is
timeout-sensitive, so future speedups must compare semantic fact counts, not
only command hashes and wall time.

Accepted reference-cache product reuse with incomplete-row protection: the
first same-product attempt proved the mechanical speedup, dropping the second
`semantic.references.cache-scan` from 751ms in the accepted control to 1ms with
zero cache reads, but it also exposed timeout-shaped empty Rust reference rows.
The final accepted shape keeps a command-local incomplete set: if a Rust batch
omits a reference row because rust-analyzer timed out, later passes in the same
semantic product skip that symbol instead of retrying and caching `[]` as if it
were compiler-backed evidence. The final Vega run kept the `0c6810...` output
hash, measured 81.260s, and recorded `incompleteInMemoryHits: 11` on the second
cache scan. Wall time is still dominated by Rust reference variance, but the
duplicate cache scan is gone and timeout uncertainty is no longer frozen into
the durable semantic-reference cache.

Decision: accepted against the immediate guard. This is the first large Vega
Rust first-fill speedup that did not rely on broad SCIP occurrence promotion or
changed phase ordering. The next frontier is either reducing the remaining
Rust reference provider loop, making the rust-analyzer project session durable
across CLI processes, or narrowing the semantic cache-scan cost after the
compiler-backed facts are warm.

Accepted `Default::default` struct-update fast path with definition guard:
the Rust default-impl source shortcut now recognizes explicit owner struct
updates such as `DictationSettings { ..Default::default() }` only when the
default impl symbol has a definition mention. The unguarded attempt was
rejected on SynthRunnerRust: it promoted a derived/generated `VisualizerBar`
default symbol that has no impl definition mention and dropped semantic
references from 3,117 to 3,115 after comment-handling regression. The guarded
shape restores SynthRunnerRust parity: 3,117 references, 16 default fast-path
rows, and 167 default fast-path references.

On VegaAssistant, the guarded run measured 75.830s for
`__health-phase complexity-hotspots --full`, down from the previous accepted
81.260s run. The reference provider loop fell from 56.010s to 51.102s, the
Rust worker reference span fell from 38.874s to 33.986s, and rust-analyzer
reference requests fell from 578 to 577. Semantic reference facts increased
from the previous accepted 22,308 back to the 30s diagnostic count of 22,316.
The command output hash changed from `0c6810...` to `5c75ff...`; the top five
hotspots stayed identical, while `extremeCount` changed from 20 to 19. This is
accepted as a compiler-backed accuracy correction, not as a same-output
speedup: direct 30s rust-analyzer probes exactly matched the two newly
source-resolved rows, `DictationSettings::default` and
`CompetenceProbeContext::default`, four references each.

Rejected follow-up: foreign explicit struct-default accounting let the source
helper resolve additional Vega defaults such as `SkillDefinition::default`
(23 refs) and `PersonaPromptConfig::default` (6 refs), while preserving the
Synth `VisualizerBar::default` guard. The full Vega run still measured 78.548s
with output hash `0c6810...`, semantic reference facts dropped from the accepted
22,316 to 22,314, and durable semantic reference rows dropped from 7,186 to
7,180. This repeats the `From::from` scheduling failure mode: removing a few
slow positive LSP requests can cause unrelated Rust reference requests to time
out. The code was reverted.

Rejected follow-up: target-owner chunk-boundary reconstruction tried to recover
more explicit `Default::default()` struct updates across truncated SCIP mention
chunks. SynthRunnerRust preserved its hash and semantic row counts, but
VegaAssistant measured 80.798s, returned the older `0c6810...` hash, wrote only
7,177 durable semantic reference rows, and left 9 slow reference tasks
incomplete. Running the same code with
`SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS=30000` restored 7,186 durable
semantic reference rows but measured 81.195s, slower than the accepted guarded
Default run and slower than the retry-only diagnostic. The code was reverted.
Future work should stabilize the Rust reference session or retry incomplete rows
before promoting more positive standard-trait source shortcuts.

Accepted opt-in Rust reference retry seam:
`SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS` now lets a timed-out
rust-analyzer reference request retry once with a separate per-request
deadline. The default remains unchanged. The Vega diagnostic run with
`SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS=30000` and slow-task profiling
measured 77.337s, kept the `0c6810...` command hash, restored the accepted
22,316 semantic reference facts, and wrote 7,186 durable semantic reference
rows. The slow reference profile had 15 slow tasks and 0 incomplete tasks; the
session span recorded `referenceRetryTimeoutMs: 30000`.

Decision: keep the retry seam as an opt-in accuracy/stability instrument. It is
not a default speedup: it is 1.507s slower than the best guarded
`Default::default` run at 75.830s, but 4.185s faster and more complete than the
slow-task diagnostic run that left 8 reference tasks incomplete. The next speed
work should use this seam to prevent scheduling regressions while moving more
Rust standard-trait cases to source-backed parity proofs or a durable
rust-analyzer session.

Retry timeout tuning: 15s is rejected despite completing every profiled slow
task, because the provider loop recorded only 22,314 semantic references and
674 worker references. A 20s retry restored the accepted 22,316 semantic
references and 676 worker references, but measured 78.412s. In this sample the
30s retry remains the fastest accurate retry run at 77.337s, so the policy
question is not solved by simply lowering the retry ceiling.

Rust callee task profiling:

The Rust session worker now has gated callee diagnostics matching the existing
reference diagnostics. `SCIP_RUST_SEMANTIC_CALLEE_TASK_PROFILE_MS` writes
per-task `rust.semantic.worker.callee-task` spans, and profiled runs write
`rust.semantic.worker.callees.by-file` rollups. Normal runs are unchanged
because the events are emitted only when `SCIP_QUERY_PROFILE` is enabled.

The first VegaAssistant callee-profile run measured 79.082s for
`__health-phase complexity-hotspots --full`, kept the `0c6810...` command hash,
and wrote the expected 7,186 durable semantic reference rows and 7,186 durable
semantic callee rows. The profile showed `rust.semantic.worker.callees` at
23.748s for 7,186 definitions and 66,469 callees. The top callee rollup was
`src-tauri/crates/vega-core/src/productivity.rs`: 28 definitions, 16 with
callees, 170 callees, 37.203s summed task time, and 15 slow tasks over the 1s
threshold. The slowest single callee task was `get_task_by_source_key`, which
took 4.280s and returned zero callees.

Decision: keep the callee profiler as evidence infrastructure, not as a
speedup. This profile does not justify a broad skip rule: most callee-capable
definitions do return callees, and the slow zero-callee cases are mixed with
nearby positive project functions. The next callee speed frontier remains
architectural batching/durable rust-analyzer session work or a source-backed
zero-callee proof that is validated against this new task-level profile.

Rejected scheduling follow-up: forcing
`SCIP_RUST_SEMANTIC_PARALLEL_OPERATIONS=0` on the same VegaAssistant phase
measured 84.140s with the same `0c6810...` command hash, but durable semantic
reference rows dropped from 7,186 to 7,183 while semantic callee rows stayed at
7,186. The current contention hypothesis did not hold, so the combined
reference/callee session should keep parallel operations enabled by default.

Status capability calibration:

The language capability matrix already reported Rust semantics as available,
but the top-level capability summary still only exposed
`semantic-typescript`. The summary now emits one semantic capability per
detected semantic provider, preserving `semantic-typescript` and adding
`semantic-rust` when Rust is detected. Local `node dist/cli.js status
--capabilities --json` now reports both TypeScript and Rust semantic providers
as available in the top-level summary.

Rust method-call source facts and source-zero callee proof:

The first source-zero audit rejected a broad shortcut. Using cached source
facts, VegaAssistant had 856 Rust definitions with zero source-owned callsites,
but 699 of them still had semantic callees; SynthRunnerRust had 844 zero-source
definitions and 90 semantic-positive mismatches. The examples were ordinary
Rust method chains such as `.zip`, `.clamp`, `.map`, `.clone`, and `.cmp`, which
showed that source facts were stale or incomplete rather than proving zero
callees.

Accepted accuracy fix: Rust source call extraction now recognizes
`field_identifier` leaves and `generic_function` wrappers, so
tree-sitter-rust method chains and generic calls such as
`serde_json::from_str::<Value>(...)` produce callsite facts. Source-facts
payloads now carry a version and old rows deserialize as misses, which prevents
prior parser behavior from surviving across upgrades. Focused tests cover Rust
method-chain/generic/macro callsites and source-facts payload-version rebuilds.

After the fix, the audit improved sharply. VegaAssistant source facts now
reported 177,626 Rust callsites; zero-source cached definitions fell from 856
to 167, with semantic-positive mismatches falling from 699 to 12.
SynthRunnerRust reported 5,211 Rust callsites and had 752 zero-source cached
definitions with 0 semantic-positive mismatches. A stricter proof using exact
source-callable ranges was clean on both fresh corpora: VegaAssistant had 119
exact source-callable zero-callee definitions and 0 semantic-positive
mismatches; SynthRunnerRust had 78 and 0.

Accepted narrow skip: Rust semantic provider construction now injects a
source-zero-callee oracle from the current DB. The provider skips rust-analyzer
callee requests only for exact Rust source-callable ranges whose current source
facts contain no callsites inside the callable body. Prefetched semantic
callees still win, and oracle failures fall back to rust-analyzer.

Measured result: VegaAssistant
`__health-phase complexity-hotspots --full` with callee task profiling measured
81.189s under `vega-complexity-source-zero-callee-skip`. The callee worker saw
7,067 definitions instead of 7,186, proving 119 requests were removed, but wall
time did not improve versus the 79.082s callee-profile control. The output hash
changed to `1ae23ffa26e6217a90938b8c124c41e9bb65dc9148058ba213aa97b4aa12adfe`
because Rust method-call source facts now add previously missing AST callee
evidence; this is an accuracy change, not a speed-equivalence run. Durable
semantic callees stayed at 7,186, while semantic reference rows were 7,176 in
this run.

SynthRunnerRust `health --full --json` measured 16.052s under
`synth-runner-rust-health-full-source-zero-callee-skip`, with 1,312 callee
worker definitions and 2,541 worker callees. This is not a clean speed win over
the prior best SynthRunnerRust runs, so the decision is to keep the parser/cache
accuracy fix and the proven-empty request skip, but not to claim a full-pass
runtime improvement from this slice. The next speed frontier is still reducing
positive rust-analyzer call hierarchy/reference work, likely through durable
session/index reuse.

### Rust SCIP Occurrence Positive Callee Proof

The next narrow callee slice uses compiler-resolved SCIP occurrences only when
they exactly match current source callsite facts inside the same Rust callable
range. A positive callee proof means a Rust caller's source call leaves and
line numbers match the compiler occurrence leaves and line numbers as a
multiset; if the caller is `main`, belongs to a Rust trait impl member, resolves
to any trait impl member callee, has no current source facts, or has any
mismatch, the provider falls back to rust-analyzer.

Accepted implementation:

- `src/source/source-calls.ts` unwraps `generic_function` call targets, and
  `src/source/source-facts.ts` increments the source-facts payload version.
- `src/semantic/rust/scip-occurrence-callees.ts` builds a per-DB SCIP
  occurrence callee index and returns callees only for exact source/SCIP
  equality proofs.
- `src/semantic/rust/provider.ts` asks this oracle before rust-analyzer callee
  resolution, both in callee-only and combined reference/callee paths. Proven
  rows are returned directly; unproven rows continue through the existing
  resolver.
- `rust.scip-occurrence.callees` profile spans report definitions, candidates,
  proven definitions, and proven callee rows when profiling is enabled.

Correctness audit before implementation:

| Corpus          | Candidate callers | Exact matches | Mismatches after structural guard |
| --------------- | ----------------: | ------------: | --------------------------------: |
| SynthRunnerRust |                28 |            28 |                                 0 |
| VegaAssistant   |                86 |            86 |                                 0 |

Measured result after implementation:

| Run                                                             | Wall time | Hash                                                               | Proof count                                  |
| --------------------------------------------------------------- | --------: | ------------------------------------------------------------------ | -------------------------------------------- |
| `synth-runner-rust-health-full-scip-occurrence-callee`          |   15.394s | `3d9caaf2b56cc70265bdfe660d71da9dc115181945f22fa190c57c911f11443e` | 12 definitions / 23 callees in profiled run  |
| `vega-complexity-scip-occurrence-callee`                        |   79.089s | `1ae23ffa26e6217a90938b8c124c41e9bb65dc9148058ba213aa97b4aa12adfe` | 64 definitions / 136 callees in profiled run |
| `synth-runner-rust-health-full-scip-occurrence-callee-profiled` |   15.478s | same                                                               | 1,372 candidates, 12 proven definitions      |
| `vega-complexity-scip-occurrence-callee-profiled`               |   79.278s | same                                                               | 6,573 candidates, 64 proven definitions      |

Decision: accepted as a safe positive-callee request elimination and profiling
hook, not as the main speed win. SynthRunnerRust improved slightly versus the
source-zero slice, while VegaAssistant stayed effectively flat. The proof count
is too small to move the dominant profile spans: `semantic.references.provider-loop`
and `rust.semantic.worker.references.by-file` still dominate. The next serious
Rust speed slice should audit trait/fallback reference shapes such as
`From::from`, `fmt`, `source`, `deserialize`, `clone`, and `default`, where
rust-analyzer often spends a full timeout returning zero or very few
references.

Rejected follow-up: a standard-trait zero-reference shortcut was tested and
backed out. Audit data looked attractive: normalized standard trait impl members
with zero exact SCIP occurrences had 24/24 zero semantic references on
VegaAssistant and no SynthRunnerRust cases, while the known unsafe positive
mismatches were custom traits (`RoutingConfig`, `LlmCallGuard`). But the
implemented shortcut measured worse on VegaAssistant:
`vega-complexity-standard-trait-zero-reference` took 80.799s, kept the
`1ae23ffa...` command hash, but wrote only 7,180 durable semantic reference rows
instead of 7,186. The profile showed 24 shortcut rows, `rust.semantic.worker.references`
still at 37.693s, and several unrelated reference tasks becoming incomplete.
Decision: do not skip standard-trait reference requests by zero SCIP occurrence
alone. Future reference-side work needs a session/durability fix or a stronger
per-symbol proof that does not perturb batch scheduling.

### Health Semantic Prewarm Completion Marker

Full-health semantic prewarm is the mechanism that makes repeat full passes
fast: it fills durable semantic reference/callee caches before health phases
fan out into isolated subprocesses, then writes a project marker so later runs
can skip that fill.

The marker now records `referenceIncomplete` and uses marker version 2. If Rust
reference materialization reports incomplete rows, the run keeps successful
reference and callee cache writes but returns `partial` and does not write the
reusable project marker. A future full-health run can therefore retry the
missing rows instead of falsely treating the project as fully warm. Readers
also ignore any version-2 marker that records nonzero incomplete references.

Validation:

- `npm test -- --run tests/runtime/cli-support.test.ts`
- `npm run typecheck`

Decision: accepted as warm-state correctness hardening, not as a cold-run
speedup claim. The optimization value is preventing incomplete Rust reference
batches from becoming durable "warm enough" state while the Rust LSP path is
still being stabilized.

### TypeScript tsserver Comparison

Added a hidden `typescript-semantic-compare` command and
`scripts/typescript-semantic-provider-comparison.mjs` so tsserver can be tested
against the ts-morph baseline without changing production behavior.

Measured on scip-query:

| Run         | Compared defs | Matches | Mismatches | Missing refs | Extra refs | ts-morph refs | tsserver refs |
| ----------- | ------------: | ------: | ---------: | -----------: | ---------: | ------------: | ------------: |
| sample 50   |            50 |      50 |          0 |            0 |          0 |     586.077ms |     663.878ms |
| full corpus |         4,459 |   4,349 |        110 |          773 |        108 |     725.470ms |   5,183.027ms |

VegaAssistant bounded comparison found only one indexed TypeScript definition,
so it is not a meaningful TypeScript parity corpus; the Rust-heavy Vega
profiles remain useful for Rust semantic work.

Decision: keep tsserver comparison-only. It is cheaper to construct than
ts-morph on this repo, but its scalar full-reference pass is slower and misses
baseline references. The next TypeScript speedup should optimize the trusted
ts-morph/bulk-scan path or make tsserver parity work explicit before any
default routing change.

### Native Rust Boundary

The `consumer-classify` helper proved correctness but not a warm-state speed
win. The next native candidate must be a larger contiguous computation or a
lower-overhead boundary.

Acceptance signal:

- native-off/native-on command hashes match;
- direct command runtime improves, not just one profile span;
- warm-state comparison still wins after reversing run order.

### Durable Rust Analyzer Project Session

A durable rust-analyzer project session is a long-lived local language-service
process for one repository whose distinguishing behavior is that it preserves
rust-analyzer's ready compiler state after the CLI command that requested it
has exited. The accepted implementation remains opt-in through
`SCIP_RUST_SEMANTIC_DURABLE_SESSION=1` at this historical checkpoint; Phase 6
later defaulted the same transport after the remaining product gates passed.

The command-side provider keeps its synchronous `RustAnalyzerSessionRequester`
contract. It publishes an atomic request into a repository- and helper-build-
scoped mailbox, starts a detached helper when no live helper exists, and waits
for the bounded response. The helper owns the existing worker-thread requester,
so LSP initialization, open-document tracking, reference completion, callee
resolution, and one-shot fallback behavior are not duplicated.

Live-session reuse is fail-closed. Its identity includes:

- protocol version;
- canonical project root;
- content hashes for Rust source and common build inputs, including
  `Cargo.toml` and `Cargo.lock`;
- resolved rust-analyzer path and version;
- semantic worker build hash; and
- Rust/Cargo environment values that can change compiler answers.

The durable helper build hash scopes the mailbox directory itself. Request
timeout, diagnostics, settle, concurrency, retry, profiling, and SCIP
occurrence policy do not identify rust-analyzer's compiler state; changing
those per-request controls no longer tears down a compatible session. An
identity mismatch shuts down the old worker before the helper creates a new
one. A missing, dead, stale-heartbeat, wrong-protocol, or changed-helper state
is not reused. Per-command worker environment is applied before every request,
and explicit settle/retry experiments remain explicit.

Readiness version 2 is an observed ordering contract around the real analyzer.
The client advertises and validates `experimental/serverStatus`, treats a
quiescent warning as usable and an error as unusable, opens the requested
documents while initial workspace loading is still underway, then waits once
for the initial quiescent status. A private `scip-query/readinessBarrier`
request provides the final JSON-RPC ordering fence: rust-analyzer's expected
`MethodNotFound` response proves that all earlier open notifications were
dequeued; any other response error fails closed. This avoids assuming that
rust-analyzer emits a new status notification for every `didOpen`, which the
real server does not promise.

Durable requests preserve the caller's settle policy. When the caller has not
configured a reference retry, the durable transport adds one bounded 30s
completion retry for definitions that rust-analyzer initially leaves
incomplete; `SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS=0` disables it
explicitly. The retry does not fabricate answers: incomplete rows remain
observable and prevent the health prewarm marker from becoming reusable-warm.

The first default experiment exposed a correctness boundary that command hashes
alone missed. Reusing a session whose first small combined batch inherited the
adaptive zero-settle policy changed eight cached callee payloads:

| Run                                  | Wall time | Cache rows | Callee facts | Nonempty callee rows | References | Output hash |
| ------------------------------------ | --------: | ---------: | -----------: | -------------------: | ---------: | ----------- |
| zero-settle session-cold, rejected   |    6.670s |      4,521 |        3,124 |                1,413 |      4,520 | `500f4e...` |
| zero-settle session-warm, diagnostic |    3.940s |      4,521 |        3,167 |                1,421 |      4,520 | `500f4e...` |

Root cause: the newly initialized reusable session issued its first callee work
before the compiler view reached the same stable state observed by the later
command. The durable host now applies the conservative 5s readiness settle once
when it creates or invalidates an identity; reused requests retain the accepted
adaptive zero-wait path. An explicitly configured settle value, including
zero, is still honored.

Accepted evidence-cold pair on scip-query itself. Semantic references,
semantic callees, the health marker, and the health report cache were cleared
before both commands; the helper was absent before the first and retained
before the second:

| Run                          | Wall time | `health.semantic-prewarm` | Opened docs | Cache rows | Callee facts | References | Output hash |
| ---------------------------- | --------: | ------------------------: | ----------: | ---------: | -----------: | ---------: | ----------- |
| session-cold first fill      |   11.440s |                    9.366s |           2 |      4,521 |        3,167 |      4,520 | `500f4e...` |
| session-warm evidence refill |    3.860s |                    1.922s |           0 |      4,521 |        3,167 |      4,520 | `500f4e...` |

The evidence-cold/session-warm run is 66.3% faster. The full semantic reference
and callee payloads compare identically in both directions, reference
incomplete count is zero, and the command output hashes match. The warm profile
contains no rust-analyzer initialization span and no document-readiness wait.

Decision at the local-corpus checkpoint: accept durable session reuse as an
opt-in experimental path. Keep the per-command worker as the default and
fallback until the same evidence-cold/session-warm contract is measured on
SynthRunnerRust and VegaAssistant.

#### Multi-corpus calibration: rejected for default routing

The external calibration cleared semantic references, semantic callees, the
health semantic-prewarm marker, and the health report cache before every run.
The detached helper was removed before each session-cold control and retained
before each attempted session-warm control. Semantic rows were hashed in stable
`relative_path, symbol` order in addition to comparing command output.

SynthRunnerRust showed a repeatable fresh-session readiness failure:

| Control                        | Wall time | Session disposition | Reference facts | Callee facts | Nonempty callee rows | Output hash   |
| ------------------------------ | --------: | ------------------- | --------------: | -----------: | -------------------: | ------------- |
| forward session-cold           |   21.052s | `created`           |           3,117 |        2,541 |                  537 | `3d9caaf2...` |
| forward session-warm           |    1.568s | `reused`            |           3,117 |        2,564 |                  540 | `47291cda...` |
| explicit identity invalidation |   14.722s | `invalidated`       |           3,117 |        2,541 |                  537 | `3d9caaf2...` |
| reverse warm-first             |    1.764s | `reused`            |           3,117 |        2,564 |                  540 | `47291cda...` |
| reverse cold-second            |   14.768s | `created`           |           3,117 |        2,541 |                  537 | `3d9caaf2...` |

Reference payloads were byte-identical in all five controls. Fresh or
invalidated sessions always produced the same callee digest
`0ff74585...`; reused sessions always produced `e85e448d...`, adding 23
callee facts across three rows. Reversing run order did not change either
result. The fixed first-session settle therefore does not establish a stable
compiler view on this corpus.

VegaAssistant exposed a separate identity-partition failure:

| Control              | Wall time | Reference rows / facts | Callee rows / facts | Prewarm result                   | Output hash   |
| -------------------- | --------: | ---------------------: | ------------------: | -------------------------------- | ------------- |
| session-cold         |  162.327s |        38,222 / 83,440 |    38,222 / 104,293 | partial, 1 incomplete reference  | `fc06912f...` |
| session-warm attempt |  177.324s |        38,220 / 83,079 |     38,222 / 98,832 | partial, 7 incomplete references | `1b25112e...` |

The second Vega command was 9.2% slower, lost 361 reference facts and 5,461
callee facts, and did not qualify as a reused project session. The first
command's large combined request created the session, but later scalar request
shapes changed request settings included in the durable identity and forced an
`invalidated` transition. The next command therefore invalidated again instead
of inheriting the warm compiler state. Additional reverse-order repetitions
would only repeat fresh-session work, so the calibration stopped after the
paired result rather than spending two more multi-minute runs on a state the
protocol cannot currently preserve.

Multi-corpus decision: reject default routing. The environment flag remains
available for controlled experiments, but the durable path is not yet a
production-safe substitute for the per-command worker. The next slice must
separate stable compiler-session identity from per-request execution policy and
replace the fixed first-fill delay with an observed readiness barrier. Then
rerun these exact controls before reconsidering rollout.

#### Readiness version 2 follow-up: accepted on all corpora

The rejected rows above remain the historical baseline. After separating
compiler identity from request policy, replacing per-open status assumptions
with the combined initial-open ordering barrier, and adding the bounded
durable-only incomplete-reference retry, the exact controls were rerun from
implementation HEAD `1301f216035ca2935a6f6d1d904834d3991bef58`.

Every command retained `index.db` and cleared only semantic references,
semantic callees, the health semantic-prewarm marker, and the health report
cache. The invalidation and reverse controls used `RA_LOG=warn` as a real
compiler-environment identity change. The scoped helper was stopped by its
verified `server.json` PID immediately before each cold control; no process-name
kill was used.

| Corpus          | Control              | Wall time | Disposition   | Reference rows / facts | Callee rows / facts | Incomplete Rust refs |
| --------------- | -------------------- | --------: | ------------- | ---------------------: | ------------------: | -------------------: |
| scip-query      | session-cold         |    8.270s | `created`     |         4,613 / 17,074 |       4,614 / 3,248 |                    0 |
| scip-query      | session-warm         |    4.780s | `reused`      |         4,613 / 17,074 |       4,614 / 3,248 |                    0 |
| SynthRunnerRust | session-cold         |   20.310s | `created`     |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| SynthRunnerRust | session-warm         |    1.760s | `reused`      |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| SynthRunnerRust | identity-invalidated |   19.790s | `invalidated` |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| SynthRunnerRust | reverse-warm-first   |    2.080s | `reused`      |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| SynthRunnerRust | reverse-cold-second  |   20.320s | `created`     |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| VegaAssistant   | session-cold         |  161.710s | `created`     |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |
| VegaAssistant   | session-warm         |   83.860s | `reused`      |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |
| VegaAssistant   | identity-invalidated |  155.690s | `invalidated` |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |
| VegaAssistant   | reverse-warm-first   |   80.970s | `reused`      |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |
| VegaAssistant   | reverse-cold-second  |  159.760s | `created`     |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |

Exact payload identities were stable within each corpus:

| Corpus          | Output SHA-256                                                     | Reference SHA-256                                                  | Callee SHA-256                                                     | Nonempty reference / callee rows |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------: |
| scip-query      | `7fca13f196958097c45856d673dbeb9a83a1ffeefeb725436d2b5f1cd1a2ba63` | `b6fd55ebf71947b0f972df9f610c216cfe95b1018901fa6c9c1cfe46be461bb0` | `730dc3f5baf403cc74cec4a5d0a188a74c0dbe647deb428705f592b8c6ed3630` |                    4,230 / 1,452 |
| SynthRunnerRust | `47291cda33601a501f2dfb123aed34e457a21bc238c508007d99c4473a1495c4` | `e24c89c7f5dbef47c0c863b104f9d6298b65954420b900b7dae1c909b8b0b2f5` | `ac0ab832b906be3c2f126b7aeaf35de4fa4a581aa01a50c8e0827921b6d9c466` |                        640 / 540 |
| VegaAssistant   | `7e944222c34dcae93bdf6a8efb52f2fa64432ef9dd86fbe2a7d1742cfa5ad629` | `6b537edd5127bb7036493a27ea074c4e7b57a5c4c2420e8f51c52603bd2719af` | `7a306badd68a8842807d93519833125fb445a7ee8c1b8ca37cff0610cf984a5a` |                  13,598 / 14,443 |

Warm reuse improved scip-query by 42.2%, SynthRunnerRust by 91.3% forward
and 89.8% in reverse order, and VegaAssistant by 48.1% forward and 49.3% in
reverse order. No accepted run used worker fallback. Vega's fresh readiness
status was quiescent with warning health; its six generic incomplete-cache
observations were three unsupported-language definitions observed twice, while
the Rust semantic prewarm itself reported zero incomplete references.

Follow-up decision: the durable transport now passes the recorded correctness,
invalidation, order, and >=20% performance gates on both external corpora and
is eligible for a separate default-routing decision. This campaign keeps the
flag opt-in because changing the product default was outside the calibration
plan; it no longer withholds eligibility for correctness or performance.

#### Complete-response reuse: accepted at the 50-second Vega gate

The next campaign profiled the 80.97–83.86-second Vega warm path and tested
three ways to remove its remaining compiler work. A live response entry is one
in-memory cached computation owned by the durable helper; what distinguishes it
from durable evidence is that it exists only while the exact compiler identity
and exact combined request remain alive, and stopping or invalidating the
helper destroys it.

Two implementation experiments were rejected and reverted before the accepted
slice:

- Audited standard-trait SCIP promotion preserved exact external-corpus facts,
  but promoted only 50 Vega definitions and three reference facts. Vega warm
  measured 110.189s, with the reference provider still at 63.521s.
- Two parallel rust-analyzer workers preserved facts but competed for CPU and
  memory. Vega warm measured 96.200s at concurrency 8, 109.572s at concurrency
  16, and 95.185s at concurrency 4.
- A pre-implementation callee audit found only 3,030 exact rows among 3,420
  apparently supported expanded call-syntax rows; the 390 mismatches made that
  rule unsafe, so it was not implemented.

The accepted slice keeps one complete combined reference/callee response in
`DurableRustSessionHost`. Its key includes all request fields and ordered
definition lists except the moving absolute readiness deadline. It stores only
available responses with no incomplete references, clears before compiler
identity replacement and shutdown, never serves a newly created or invalidated
session, and leaves import-definition requests uncached. Durable routing remains
opt-in.

Every control cleared semantic evidence and the health caches while retaining
`index.db`. The cold controls therefore still performed real compiler work; a
warm response hit avoided only the repeated compiler query and then repopulated
the normal SQLite evidence rows.

| Corpus          | Control              | Wall time | Disposition   | Response entry | Reference rows / facts | Callee rows / facts | Incomplete Rust refs |
| --------------- | -------------------- | --------: | ------------- | -------------- | ---------------------: | ------------------: | -------------------: |
| scip-query      | session-cold         |   14.223s | `created`     | miss           |         4,618 / 17,091 |       4,619 / 3,252 |                    0 |
| scip-query      | session-warm         |   12.233s | `reused`      | hit            |         4,618 / 17,091 |       4,619 / 3,252 |                    0 |
| scip-query      | identity-invalidated |   13.348s | `invalidated` | miss           |         4,618 / 17,091 |       4,619 / 3,252 |                    0 |
| scip-query      | reverse-warm-first   |   11.908s | `reused`      | hit            |         4,618 / 17,091 |       4,619 / 3,252 |                    0 |
| scip-query      | reverse-cold-second  |   18.806s | `created`     | miss           |         4,618 / 17,091 |       4,619 / 3,252 |                    0 |
| SynthRunnerRust | session-cold         |   30.040s | `created`     | miss           |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| SynthRunnerRust | session-warm         |    2.699s | `reused`      | hit            |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| SynthRunnerRust | identity-invalidated |   21.679s | `invalidated` | miss           |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| SynthRunnerRust | reverse-warm-first   |    2.504s | `reused`      | hit            |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| SynthRunnerRust | reverse-cold-second  |   20.815s | `created`     | miss           |          1,661 / 3,117 |       1,661 / 2,564 |                    0 |
| VegaAssistant   | session-cold         |  190.685s | `created`     | miss           |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |
| VegaAssistant   | session-warm         |   41.933s | `reused`      | hit            |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |
| VegaAssistant   | identity-invalidated |  175.956s | `invalidated` | miss           |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |
| VegaAssistant   | reverse-warm-first   |   46.310s | `reused`      | hit            |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |
| VegaAssistant   | reverse-cold-second  |  168.937s | `created`     | miss           |        38,222 / 83,440 |    38,222 / 104,425 |                    0 |

External-corpus identities remained byte-for-byte equal to readiness version 2:

| Corpus          | Output SHA-256                                                     | Reference SHA-256                                                  | Callee SHA-256                                                     | Nonempty reference / callee rows |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------: |
| SynthRunnerRust | `47291cda33601a501f2dfb123aed34e457a21bc238c508007d99c4473a1495c4` | `e24c89c7f5dbef47c0c863b104f9d6298b65954420b900b7dae1c909b8b0b2f5` | `ac0ab832b906be3c2f126b7aeaf35de4fa4a581aa01a50c8e0827921b6d9c466` |                        640 / 540 |
| VegaAssistant   | `7e944222c34dcae93bdf6a8efb52f2fa64432ef9dd86fbe2a7d1742cfa5ad629` | `6b537edd5127bb7036493a27ea074c4e7b57a5c4c2420e8f51c52603bd2719af` | `7a306badd68a8842807d93519833125fb445a7ee8c1b8ca37cff0610cf984a5a` |                  13,598 / 14,443 |

The local corpus changed during the campaign because the implementation and
tests are themselves indexed; its five controls were exact against one another
at output `10f3cd21...`, reference digest `97c8ec4f...`, and callee digest
`4298616d...`. No accepted control used `worker-fallback`.

Vega forward warm improved 50.0% from 83.860s to 41.933s, and the reverse warm
control improved 42.8% from 80.970s to 46.310s. The decisive compiler request
fell from 148.531s cold to 0.680s warm. The largest remaining warm span is now
the normal semantic evidence materialization path: it spent 24.704s writing
38,222 reference rows and 38,222 callee rows. That bulk persistence work, not
rust-analyzer readiness or concurrency, is the next measured optimization
target.

The Synth run initially labeled `identity-invalidated` was classified
`created` because its helper expired while the Vega matrix ran. It remains a
diagnostic record. The accepted `identity-invalidated-v3` control used an inert
`RA_TEST_IDENTITY` change and was classified `invalidated`; an interrupted
`RA_LOG=info` attempt produced no accepted history record because logging itself
confounded the control.

#### Semantic-prewarm attribution and bulk definition route: rejected

The response-cache checkpoint left 24.704s inside one outer semantic-prewarm
span, so the next campaign first divided it into four retained child spans:
candidate definitions, references, callees, and marker writing. A true Vega
response-cache-hit control accounted for all but 40ms of the 26.055s outer
span:

| Vega warm child               | Baseline duration | Definitions / rows |
| ----------------------------- | ----------------: | -----------------: |
| candidate definitions         |           13.837s |             38,222 |
| reference materialization     |            4.849s |             38,222 |
| callee materialization        |            7.329s |             14,367 |
| complete-marker write         |            0.000s |                  — |
| unaccounted inside outer span |            0.040s |                  — |

That result disproved the earlier description of the whole outer span as
SQLite persistence. Candidate definition loading was the largest child, while
the already-batched semantic writes remained a small part of the reference and
callee spans.

The health-only experiment replaced `ProjectIndex.scopedDefinitions()` with
the existing set-oriented primary/fallback definition query. It passed an exact
full-object/scoped fixture, 36 neighboring tests, typecheck, build,
`recent-duplicates`, and `unused-params`. Local and SynthRunnerRust controls
were exact and slightly faster, but the decisive Vega control did not improve:

| Corpus / control           | Full command | Prewarm | Candidate load | Output identity |
| -------------------------- | -----------: | ------: | -------------: | --------------- |
| local session-warm         |       9.933s |  5.440s |         2.355s | internal exact  |
| SynthRunnerRust warm       |       2.413s |  1.091s |         0.517s | `47291cda...`   |
| Vega pre-change warm hit   |      45.918s | 26.055s |        13.837s | `7e944222...`   |
| Vega set-oriented warm hit |      49.074s | 28.658s |        14.050s | `7e944222...`   |

Vega retained all 38,222 semantic reference rows and 38,222 callee rows, used
the exact durable response-cache hit, and had no worker fallback. The route was
nevertheless rejected because it missed both gates: prewarm was above 10s and
full health was above 30s. Commit `8b8dcdcf` reverted the production/test slice;
the profiler and measurements remain.

The N+1 SQL hypothesis was therefore false in the measured warm state. The
scalar route consumes durable corrected-definition evidence, while the bulk
route repeats source-range correction after its set-oriented row load. The next
candidate-loading investigation must separately time evidence validation,
payload decoding, fallback row loading, and range correction before choosing a
new cache shape or native boundary. This result does not justify Rust by itself.

Machine-readable controls and profile paths are in
`docs/benchmarks/runs/2026-07-09-semantic-prewarm-bulk-load.jsonl`.

## Automatic Freshness Service

The next accepted slice changes the refresh lifecycle rather than the compiler
index format. One demand-started daemon now owns each enabled project while it
is active. Normal commands and agent hooks start or touch it; file/Git events
use the existing single-flight watcher; clean inactivity ends it after 10
minutes by default; the next command starts a new process and checks the full
content fingerprint before publishing readiness.

The index/output contract remains the same. Foreground watch and manual reindex
remain fallbacks, only one foreground/background owner can hold the project
lock, failed refreshes keep the preceding atomic generation readable, and
ordinary query JSON is unchanged. `status` and `watch` intentionally gain
additive lifecycle fields/options.

The pre-registered nine-pair state-machine matrix covered 250/750/1500 ms
debounce crossed with 0/1000/5000 ms cooldown. Every pair coalesced 20 writes
into one refresh and an edit during indexing into exactly one follow-up, with
zero concurrent reindexes. The larger eight pairs were not selected because
they added quiet/cooldown latency without adding safety. Five real repository
runs for each accepted edit shape selected 250 ms debounce and zero cooldown:

| Scenario                  | Observe median/p95 | Indexing median/p95 |  Fresh median/p95 | Refresh median/p95 | Restore median/p95 | Output        |
| ------------------------- | -----------------: | ------------------: | ----------------: | -----------------: | -----------------: | ------------- |
| One TypeScript leaf edit  |         27 / 27 ms |        263 / 288 ms | 4.543 s / 4.885 s |  3.849 s / 4.200 s |  4.710 s / 4.834 s | `dbae4362...` |
| Twenty writes over 500 ms |       526 / 531 ms |        791 / 839 ms | 5.065 s / 5.229 s |  3.897 s / 3.973 s |  4.554 s / 4.951 s | `dbae4362...` |

Every burst had one observed indexing transition. All ten accepted trials
restored a fresh index with the same `kind-counts --json` hash. The final graph
snapshot contained 302 documents, 19,870 symbols, 18,554 definitions, and
46,285 references. The zero-cooldown path was accepted because single-flight
still forbids concurrent indexing and the dirty bit permits only one immediate
follow-up; the measured 1s cooldown candidate added restore latency without
changing that safety contract.

Five exact unchanged refreshes reused both TypeScript and Rust shards. Internal
refresh time was 329 ms median / 348 ms p95; whole-CLI wall time was 534 ms
median / 544 ms p95. Final five-run lifecycle controls were:

| Lifecycle operation                 | Median |    p95 | Identity/result              |
| ----------------------------------- | -----: | -----: | ---------------------------- |
| Cold service start                  | 525 ms | 540 ms | one healthy owner            |
| Stopped status control              | 144 ms | 151 ms | ordinary Node/CLI floor      |
| Ensure compatible live service      | 144 ms | 147 ms | same PID in all five runs    |
| Ensure minus stopped-status control |  -1 ms |   9 ms | no measurable added overhead |
| Graceful stop                       | 367 ms | 374 ms | state/lock removed           |
| 50 ms configured idle exit          | 261 ms | 265 ms | clean exit on 250 ms poll    |
| Wake after idle                     | 549 ms | 560 ms | new PID in all five runs     |

The literal whole-process live-ensure p95 was 147 ms, missing the pre-registered
100 ms wall target because this built Node CLI itself measured 151 ms p95 for a
stopped status read. The service-specific incremental comparison was <=9 ms p95
and the normal command path performs that ensure inside an already-required CLI
process. This is recorded as a target miss rather than relabeling the 147 ms
measurement. Before the final activity-poll tuning, a 50 ms test timeout was
observed on the 1s heartbeat boundary; the accepted server keeps the 1s durable
heartbeat but polls activity/signals every 250 ms so idle/stop responsiveness
does not multiply state-file writes.

Early edit records with an approximately 1 ms indexing start are diagnostic,
not acceptance runs: writing the benchmark JSONL had changed the project
fingerprint before daemon startup, so startup recovery was already indexing
when the fixture edit occurred. The harness now prepares a fresh index before
each scenario and buffers JSONL writes until the daemon stops. Early output
hashes based on `stats` are also diagnostic because that command includes a
changing build time; accepted parity uses stable `kind-counts` output.

Machine-readable measurements are in
`docs/benchmarks/runs/2026-07-09-automatic-freshness.jsonl`.

## Current Checkpoint

This checkpoint summarizes the last optimization push so the direction is easy
to recover without rereading every benchmark artifact.

What is materially done:

- Rust semantic support is now compiler-backed enough for the health/full-pass
  work: references, callees, signatures, import-definition support, cache
  identity, incomplete-reference tracking, and source/SCIP fast paths all have
  targeted tests and benchmark evidence.
- Full-health semantic prewarm is the accepted warm-state path. It fills
  durable semantic reference and callee rows before health workers fan out, and
  it writes a reusable project marker only when Rust reference materialization
  is complete.
- The Rust first-fill path is much faster than the early baseline. On
  SynthRunnerRust, cold `health --full --json` moved from the early 58s range
  to the 15s range across accepted Rust semantic slices, while warm marker-hit
  runs stayed below 1s.
- VegaAssistant remains the large mixed Rust stress case. The best accepted
  guarded Default struct-update slice measured 75.830s for
  `__health-phase complexity-hotspots --full`, with later rejected experiments
  proving that broad Rust occurrence/trait shortcuts can lose semantic facts.
- scip-query's own mixed `health --full --json` now avoids the fixed 5s
  rust-analyzer wait for small combined Rust reference/callee batches. The
  paired measurement was 15.756s with forced 5s settle versus 11.200s with the
  adaptive default, with the same output hash and durable semantic row counts.
- TypeScript tsserver comparison is implemented but not production routing.
  Full scip-query comparison found 4,349 matches out of 4,459 definitions, 110
  mismatches, 773 missing references, and 108 extra references. tsserver was
  also slower than ts-morph for the full reference pass, so ts-morph remains the
  default.
- The benchmark harness is safer: evidence-cold health runs clear the health
  report cache, and profile output paths are resolved before spawning the
  benchmarked command.
- Opt-in durable rust-analyzer reuse now survives separate CLI processes with
  source/Cargo/engine/build/environment invalidation, crash recovery, observed
  initial readiness, an ordered post-open barrier, and bounded completion retry.
  The current scip-query evidence-cold/session-warm pair fell from 8.270s to
  4.780s with identical output and semantic payloads.
- Readiness version 2 passes the full five-control calibration on both external
  corpora. SynthRunnerRust reuse improved 91.3% forward and 89.8% in reverse;
  VegaAssistant improved 48.1% forward and 49.3% in reverse. All ten external
  controls had exact payload parity, zero incomplete Rust references, expected
  dispositions, and no worker fallback.
- Complete-response reuse now removes repeated compiler semantic queries from
  the live durable helper. Vega warm full health is 41.933s forward and 46.310s
  in reverse order with exact readiness-v2 payloads, meeting the <=50s campaign
  gate while durable routing remains opt-in.
- Enabled projects now have a demand-started per-project freshness service with
  start/status/stop controls, command/hook wake-up, immediate stale startup
  refresh, single-flight coalescing, crash/stale-state recovery, and clean-idle
  exit. The calibrated 250ms/0ms policy moved a local leaf edit to fresh in
  4.543s median / 4.885s p95 and a 20-write burst to fresh in 5.065s median /
  5.229s p95 with exact restored output.

Important rejected ideas:

- Set-oriented semantic-prewarm definition loading preserved exact payloads
  but did not reduce Vega candidate time (13.837s before versus 14.050s after),
  proving that SQL query count was not the dominant warm-path cost.
- Broad semantic cache read batching did not beat the existing per-file
  prepared-statement path.
- Disabling full-health semantic prewarm changed output and wrote too few
  semantic reference rows.
- Zero diagnostics readiness is not safe; it can collapse Rust reference facts.
- Broad SCIP occurrence reference promotion is not safe for Rust fields, types,
  modules, and many fallback classes.
- Direct `From::from` and broad standard-trait shortcuts can keep the command
  hash while perturbing rust-analyzer scheduling enough to lose semantic rows.
- tsserver is not yet accurate or fast enough to replace ts-morph.
- Native Rust helper-process boundaries have not yet beaten the TypeScript path
  unless the boundary is large enough; do not convert small kernels just because
  they are Rust.

Separate follow-ups outside this completed roadmap:

- Reduce Vega semantic-prewarm candidate loading, now isolated at 13.837s of a
  26.055s warm prewarm. First split durable evidence validation/decoding from
  fallback row loading and source-range correction; the set-oriented row query
  alone did not help.
- Optimize TypeScript without replacing ts-morph by default. The trusted path is
  still ts-morph plus bulk scans; tsserver remains a comparison tool until it
  proves full parity and speed.
- Finish the guided setup flow: language detection, parser/indexer setup,
  optional hooks, and permissioned `AGENTS.md`/`CLAUDE.md` updates.
- Produce a full command calibration matrix across representative corpora so
  "full mode is fast" is a measured claim for each important command, not just
  a few hot paths.
- Revisit Rust conversion only after the semantic/session architecture is
  stable, and only for large contiguous computations where benchmark evidence
  shows the native boundary wins.

Best next campaign target: Phase 3 persistent TypeScript semantics from
`docs/plans/2026-07-09-automatic-incremental-indexing-roadmap.md`. Preserve the
service as the one project owner, reuse a live ts-morph Project across CLI
processes, and dual-read/compare per-file semantic fragments before they become
authoritative.

## 2026-07-09 — Automatic incremental indexing Phase 2 affected-set calibration

An **affected set** is the collection of indexed files whose compiler-resolved
answers may differ after an edit; unlike a changed-file list, it includes every
transitive consumer that can observe changed meaning. Phase 2 measured that set
without using it to skip production work: each prediction was compared with a
complete clean rebuild, and the complete rebuild remained the only writer.

### Accepted measurements

| Corpus/scenario                                |       Samples |        Median / p95 |       Predicted ratio | Recall | Shadow overhead | Result                                               |
| ---------------------------------------------- | ------------: | ------------------: | --------------------: | -----: | --------------: | ---------------------------------------------------- |
| scip-query exact no-op                         |             5 |       293ms / 314ms | no manifest/no shadow |    n/a |             n/a | pass; -10.94% / -9.77% versus 329ms / 348ms baseline |
| scip-query leaf `src/runtime/postinstall.ts`   | 5 alternating |   3,849ms / 3,863ms |        1/305 = 0.328% |   100% |   8.73% / 9.10% | pass                                                 |
| OpenCode leaf `packages/opencode/src/index.ts` | 5 alternating | 59,810ms / 60,738ms |     1/2,531 = 0.0395% |   100% |   5.09% / 5.42% | pass                                                 |

OpenCode commit `1a8e94dc8e7462d3d0d860e1337b448c71947f6b` was
preselected as an independent TypeScript-heavy monorepo: 29 discovered
tsconfigs, 2,967 indexed documents, and 189,683 symbols. It complements
scip-query's 305-document mixed TypeScript/Rust project rather than repeating
the generated fixture. Both capability snapshots record runnable indexers and
available ts-morph semantics.

Normalized scip-query controls stayed at 305 documents, 20,158 symbols, 4,108
definitions, 65,801 mentions, and 904 chunks. OpenCode stayed at 2,967
documents, 189,683 symbols, 18,031 definitions, 500,052 mentions, and 7,039
chunks. Fact-count and kind-count hashes were stable within each corpus and edit
direction. Raw SCIP/SQLite hashes remain recorded, but raw SQLite files can vary
while all normalized facts are equal, so raw storage bytes are not the parity
gate.

### Fixture and failure evidence

The generated seven-document project passed ordinary leaf, export-signature,
import-edge, multi-file, file-add, file-delete, ambient declaration, tsconfig,
package-manifest, malformed-metadata, and sleeping-service-wake scenarios at
100% recall. Source closures predicted only the changed files and transitive
consumers. Add/delete/ambient/config/malformed state explicitly widened to the
whole project. The harness planted an omitted affected file and observed its
verifier reject the prediction before accepting any green control.

The first OpenCode leaf attempt failed with `expected closure plan, received
full-project`; that record is intentionally preserved. A tracked internal
directory symlink was being read as a regular file, producing `EISDIR` and the
safe `unreadable-input` fallback. The correction fingerprints an internal
symlink from its stored target while external or broken targets remain
unreadable. Two focused tests cover stable internal identity, retargeting,
separate target-content changes, and external fallback. The repeated five-run
OpenCode series then passed with the 0.0395% prediction above.

### Decision

Phase 2 is accepted: every accepted trial had 100% recall, both representative
leaf ratios were below 1% against a <20% gate, uncertainty widened, and the
no-op/overhead limits passed. The prediction remains shadow-only. Phase 3 may
now use it to derive and validate persistent semantic cache keys; it does not
yet authorize partial SCIP or SQLite publication.

Machine-readable evidence:
`docs/benchmarks/runs/2026-07-09-affected-set-shadow.jsonl`.

## 2026-07-09 — Phase 3 persistent TypeScript semantics kickoff

The accepted design keeps one lazy ts-morph compiler session in the existing
repository service; it does not create a second daemon. The service remains
demand-started, exits after the configured clean-idle period, and is woken by
the next eligible CLI or hook command. Synchronous CLI calls will use atomic
request/response mailbox files and fall back to the current direct provider on
any service, protocol, timeout, or response failure.

The durable cache boundary changes from whole-project definition rows to
origin-file semantic fragments. A reference fragment belongs to the file
containing the reference and is keyed by that file plus its transitive compiler
dependencies, global TypeScript configuration/ambient inputs, project
membership, compiler engine, and schema. This is the necessary ownership rule:
a consumer can add a reference to an unchanged definition, so caching only by
the definition file would either be unsafe or remain whole-project-wide.

The pre-change five-run scip-query `unused-imports
src/semantic/shared-primitives.ts --json` baseline was 927ms median / 1,307ms
p95 with an exact stable output SHA-256 of
`de4ce6c21a7d9100288e663c7a02b12e94df85d0b773a36b353609ddc224be0b`.
Every process rebuilt Projects in 206–218ms (212ms median) and import-usage
computation took 424–451ms (432ms median). Phase 3 must produce zero new
unchanged Projects after warm-up, preserve at least 95% of eligible fragments
after a leaf edit, and meet the roadmap's >=20% command or >=50% semantic-span
improvement with exact fixture/scip-query/OpenCode parity.

Executable plan:
`docs/plans/2026-07-09-persistent-typescript-semantics.md`. Machine history:
`docs/benchmarks/runs/2026-07-09-typescript-semantic-session.jsonl`.

### Phase 3 authoritative semantic fragments

Step 3.5 moved eligible TypeScript reference reads from the whole-project
definition cache to origin-file fragments. A fully warm batch returns without
constructing a semantic provider. A partially warm batch computes only missing
files and combines them with unchanged fragments; any missing identity,
malformed payload, unavailable provider, or incomplete response returns to the
legacy route. Import usage and file-owned signature maps use the same transitive
semantic identity. TypeScript callees now use that identity instead of the old
direct-dependency digest.

The SQLite/provider fixture closed the process-persistence contract: a fresh
database object returned identical references, imports, signatures, and callees
without changing any evidence row ID. After a real ordinary edit to the
consumer source and a new published fingerprint, the API fragment remained a
hit and only the consumer fragment was replaced (one hit, one miss, one
computed file). This two-file fixture proves the selective mechanism, not the
roadmap's >=95% corpus threshold; the scip-query/OpenCode calibration in step
3.6 owns that acceptance result.

### Phase 3 acceptance

The final separate-process series passed the speed gate with exact output.
scip-query improved from 927ms median / 1,307ms p95 to 237ms / 250ms across
five accepted warm processes. OpenCode commit `1a8e94dc…`, the independent
29-tsconfig corpus, improved from five direct controls at 7,910ms / 8,133ms to
307ms / 331ms. The accepted hashes were respectively `de4ce6c…` and
`85e4aa50…`; the service constructed no additional unchanged Projects after
each cold request.

The final scip-query leaf edit retained 310/311 reference fragments (99.6785%)
and OpenCode retained 2,529/2,530 (99.9605%). Each computed only the changed
origin file, refreshed one session without replacing its Project set, and kept
the exact complexity-hotspot output hash (`c04bbfa2…` locally and `021d524d…`
on OpenCode). Preparing shared identity context once per database cut fully
warm OpenCode fragment materialization from 9,506ms to 524ms. The true reverse
leaf edit took 6,149ms for the one missing semantic fragment; its existing SCIP
rebuild still took 54.911s, which is precisely the Phase 4 target.

The first OpenCode cold fragment fill exhausted Node's default 4GB heap and
wrote zero rows. An 8GB retry exposed a TypeScript language-service exception
for declaration-file references. The retained recovery batches those failed
precise lookups through the compiler-symbol scanner and produced all 2,530
fragments in 20,900ms with exact output. This cold memory boundary remains
explicit; normal warm import analysis used the default process and passed.

Concurrency, 1ms timeout-to-direct fallback, explicit direct mode, clean idle
exit and wake, forced crash recovery, service restart, and config replacement
all returned the local baseline hash. Two concurrent processes created one
Project; a source edit created none; the config edit created exactly one
replacement. Exact no-op reindex improved to 300ms median / 333ms p95 internal
and 476ms / 500ms process-wall. All 1,180 tests, typecheck, build, lint, the
packed-install remote/direct smoke, repository reindex, matching SCIP
postchecks, and diff-gate passed. Machine records, including rejected controls,
live in `docs/benchmarks/runs/2026-07-09-typescript-semantic-session.jsonl`.

### Incremental SCIP document producer

Phase 4A inspected the installed scip-typescript 0.4.0 library rather than
stopping at its CLI flags. Its public package surface has no document API, but
the package ships the same `FileIndexer` used by `ProjectIndexer`. A stateless
root-TypeScript probe reproduced only 251/311 documents exactly because
foreign anonymous type-literal names depend on the retained project symbol
table. The accepted persistent-program probe reproduced all 311 and emitted a
true edited leaf document byte-for-byte in 3.277ms after a 1,529.850ms initial
symbol-table warm scan.

The Phase 4.1 adapter now preserves that state, replaces changed source nodes,
prunes their stale symbol entries, and rejects any unsupported optional
runtime so the whole-project CLI remains the fallback. An independent fixture
ran the installed CLI as its clean oracle across two edits and matched every
base and affected document. rust-analyzer remains at the recorded upstream
boundary: its current `scip` implementation first computes one complete
`StaticIndex`, and neither its CLI nor LSP offers document emission. Detailed
records live in
`docs/benchmarks/runs/2026-07-09-incremental-scip-documents.jsonl`.

Phase 4.2 added immutable generation manifests over content-addressed document
blobs. Every load rehashes every named fragment; an edited fixture assembled a
complete TypeScript shard byte-for-byte equal to a fresh installed-CLI index.
The negative controls proved that a missing replacement path, wrong project
identity, attempted generation mutation, and corrupt blob are rejected before
publication. Blob collection runs only after all retained manifests parse.

Phase 4.3 connected the retained producer to the existing one-writer service
through a separate versioned mailbox. Each request is tied to the currently
published base generation and exact producer/project identity, and the
requester requires exactly one returned fragment for every affected path. A
cold request followed by a disk edit reused one emitter session, performed one
program update, and returned the edited document. Malformed, expired,
stale-generation, dead-service, timeout, and intentionally omitted-document
controls were all rejected. Watch service protocol 3 replaces older daemons
and exposes producer warmup/update/request counters in status.

The first authoritative local watch trial then made two real edits to
`src/runtime/postinstall.ts` and restored it. Cold producer warmup covered all
317 documents in 2,406ms. Warm updates took 10ms and 8ms, one document each.
The edited TypeScript shard (`f53148b2…`) was byte-identical to a separate
2,410ms clean scip-typescript run; restore reproduced the original
`6af18c46…` shard hash. The temporary export was removed.

Complete refreshes were still 5,036ms cold and 2,603ms / 2,546ms warm because
the existing full merge and `scip expt-convert` publication path remains.
Accordingly, the roadmap now treats sub-500ms warm document/shard production
as the Phase 4 gate and retains the original 2s local / 5s large complete
edit-to-fresh target as the combined Phase 4+5 ship gate. This is a measured
boundary transfer, not a relaxed final target.

Final Phase 4 distributions passed. Retained local document production was
16.748ms median / 22.193ms p95 across five edits. The first OpenCode base probe
matched only 1,740/2,967 documents and was rejected: the compiler host inherited
the benchmark process directory and resolved scip-query's `@types/node`
22.19.17 rather than OpenCode's Bun-installed 24.12.2. Making the workspace
root the compiler host's explicit current directory produced 2,967/2,967 exact
base documents; an ambient-type fixture now guards this boundary.

OpenCode's five warm edit samples were 2,802.661, 2,510.632, 2,321.364,
2,315.935, and 2,324.730ms: 2,324.730ms median / 2,802.661ms p95. The assembled
119,345,147-byte incremental shard had SHA-256 `34a5a4bb…`, exactly matching a
48.24s clean full oracle. The first default-4GB oracle OOM and its 82MB partial
file are rejected evidence; the accepted oracle used the established 8GB
bound. The external file was restored in 2,229.052ms and OpenCode remained
clean. Phase 4 is closed; Phase 5 owns complete publication latency.

## Phase 5 Incremental SQLite Publication Checkpoint

Phase 5.1 converts only affected TypeScript documents with the official
`scip expt-convert` binary, attaches that mini database to a private copy of
the accepted database, and replaces document/chunk/mention/definition rows in
one transaction. Schema drift, corrupt or incomplete mini databases,
ambiguous definitions shared with unaffected documents, and injected
transaction failures all reject without changing the accepted database. A
real two-document fixture matches a clean full conversion at every normalized
fact.

Phase 5.2 connects that patch to normal publication only when TypeScript is
incremental and all other language shards are reused. The stable database path
is replaced atomically after validation; the preceding complete database is
retained under `.scipquery-generations/<identity>/index.db`. Tests hold an old
reader open across handoff, open a new reader afterward, inject failures at
all four artifact boundaries, and retain only the immediately preceding
generation. Both stable and recovery databases pass `integrity_check`.

The first real route was correct but 2.617s. Profiling showed the service was
already 8ms; repeated whole-file orchestration was the cost. Reusing validated
fragment generations, parsing the TypeScript base once for complete and mini
outputs, merging and sanitizing in one serialization, and using the already
loaded portable SCIP schema instead of loading the compiler runtime reduced
the final post-fix distribution to 1,380, 1,383, 1,390, 1,358, and 1,413ms:
1,383ms median / 1,413ms p95 against the 2,000ms gate. No-op was 311ms versus
the prior 331ms control.

One earlier candidate had 322 fact units versus the oracle's 321 because an
orphan TypeScript standard-library symbol survived from a preceding mini
conversion. That evidence is rejected. Global-symbol collection now enforces
the official converter invariant: a retained symbol must be mentioned or have
a definition range. The final restored candidate and official full conversion
both contain 321 fact units with zero normalized differences. Phase 5.3 now
owns installed-package compatibility and status visibility; large-corpus
calibration remains Phase 5.4.

Phase 5.3 makes that generation observable and self-repairing. Status reports
current/drifted/legacy/invalid state, current and recovery identities,
publication mode, validation, affected/changed counts, phase timings, and
fallback reason. Last-refresh-only metadata updates do not change identity.
A malformed record, missing recovery file, or DB/meta mismatch makes freshness
stale; both reuse shortcuts yield to a full database publication from cached
language shards, so repair does not rerun indexers. Legacy indexes without a
state file remain compatible.

The live repaired generation returned to `current`; the next incremental
restore exposed 1 affected / 1 changed document, 20ms producer, 122ms
conversion, 915ms complete TypeScript materialization, and 98ms patch within a
1,709ms refresh. A schema-mismatch control selected full conversion and
persisted its reason. A packed 0.15.0 install contained 333 files in an
815,945-byte tarball. That installed CLI and a CLI built from pre-generation
commit `d4b1d8c7` both read the same stable DB as 321 documents, 21,525
symbols, 20,129 definitions, and 50,550 references. Phase 5.3 is closed;
OpenCode and final release gates remain Phase 5.4.

### Phase 5.4 large-corpus publication

OpenCode commit `1a8e94dc8e7462d3d0d860e1337b448c71947f6b` exposed a
second whole-shard floor after the affected-document producer was already
warm. Rebuilding and sanitizing the 119MB TypeScript companion measured 13.0s
on restore and 9.6s on the next leaf edit. That implementation is rejected:
the database patch was fast, but repeatedly deserializing and serializing every
unchanged document could not meet the 5s edit-to-fresh gate.

The accepted route stores each changed SCIP document as a content-addressed
blob and records an immutable overlay manifest over one whole base shard. For
large shards, the affected-only SCIP index is serialized directly without
opening the base. The official converter produces the mini database, the
validated SQLite generation publishes atomically, and metadata reports that
the rebuildable whole SCIP companion is deferred. A full-conversion fallback
reconstructs the complete shard before conversion. Explicit deferred metadata
and an omitted TypeScript whole-shard fingerprint prevent edit reversals from
selecting the old base as a current cache hit.

Five accepted alternating leaf edits measured 4,395, 4,408, 4,303, 4,413, and
4,339ms: 4,395ms median and approximately 4,412ms p95. A sixth 4,312ms update
restored the source. Typical warm phase timing was about 0.59s graph read,
2.23s persistent-service request, 4ms affected-only assembly, 22ms official
conversion, and 0.86s validated SQLite patch. The reconstructed
119,344,942-byte current shard and the clean whole-project shard both hash to
`4e8f58e49ccfb90da91343eee4dbdbf671cd84a7d6ed06a9f880046c9b110213`.
The incremental database matches a fresh full conversion across all 2,967
normalized document fact sets.

Rejected diagnostics are retained: the first 4GB OpenCode service exhausted
the heap; two 8GB attempts exposed an ignored generated document missing from
the project snapshot; the first overlay fingerprint contract passed once at
4.464s but failed the immediate reversal by treating the base content as a
whole-shard hit. Generated documents now receive content-bound retained
identities, and the accepted deferred contract forces composition until the
whole companion is intentionally materialized. OpenCode finished clean and
fresh with current/recovery generation checks passing.

## Phase 6 Durable Rust Default and Rollout

The readiness-v2 and complete-response route is now the default Rust semantic
transport. `SCIP_RUST_SEMANTIC_DURABLE_SESSION=0` selects the previous
per-command worker, and any durable helper/readiness/timeout/request failure
automatically latches that command to the same worker fallback. Status reports
the selection, validity, fallback, and live/stopped/stale helper state.

Fresh evidence controls at the default boundary:

| Corpus | Transport | Cold | Warm | Output |
| --- | --- | ---: | ---: | --- |
| scip-query | worker opt-out | 7.436s | — | `d8706ecc…` |
| scip-query | durable default | 6.068s | 3.724s | `d8706ecc…` |
| SynthRunnerRust | worker opt-out | 21.227s | — | `3d9caaf2…` |
| SynthRunnerRust | durable default | 18.414s | 1.226s | `47291cda…` |
| SynthRunnerRust | packed durable default | 18.688s | — | `47291cda…` |

Cold improved 18.4% locally and 13.3% on SynthRunnerRust, so defaulting does
not trade first-fill latency for warm speed. The Synth output transition is an
accepted accuracy correction: worker cold reproduced the historical
fresh-session payload with missing callees, while durable readiness plus
completion retry reproduced the already accepted 1,661 rows / 3,117 reference
facts and 1,661 rows / 2,564 callee facts with zero incomplete Rust references.
The packed 0.15.0 install started its own packaged helper and reported it live.

No Rust semantic reference-key narrowing was accepted because any Rust file
can introduce a new reference to a definition; the existing dependency graph
cannot prove a file-local answer complete. No new native kernel was accepted:
the prior helper boundary lacked a warm end-to-end win, and no remaining pure
CPU slice satisfies AD-7's measured share and improvement thresholds. These
are evidence-backed rejections, not unfinished implementation items.

Final closure passed 1,218 tests across 177 files, typecheck, lint, build,
package verification, reindex, and diff-gate with zero findings or advisories.

## Automatic Indexing Setup Integration

The post-roadmap setup closure makes the completed runtime lifecycle the
default result of explicit `init` or `setup`. A missing watch decision becomes
`watch.enabled: true` with automatic refresh, an existing explicit false is
preserved by non-guided setup, and guided setup presents enablement as a
recommended action. The setup report now records the observed start/reuse
disposition, PID, watcher state, Git polling policy, and clean-idle deadline.
Rust projects expose the selected durable or worker semantic transport, helper
state, worker fallback, and opt-out. Status inspection itself is passive; the
final sample follows health so any semantic request that wakes rust-analyzer is
reported truthfully.

A packed cold TypeScript/Rust fixture began with no database, Rust build
artifacts, or `Cargo.lock`. The installed `0.15.0` package detected only the two
project languages, indexed both shards in 2,627ms, reported fresh metadata,
started an idle automatic service with a ten-minute deadline, and reported the
Rust semantic helper as `durable/live` with worker fallback after the health
audit made a semantic request. Setup recorded
12 passing smoke checks, one intentionally unavailable hook check under
`--no-hooks`, and zero failures. The 333-file tarball was 824,195 bytes with
SHA-256 `6d9673689152e891362986147572c48ca20317b426612fab1855e25918674a45`.

An explicit-opt-out packed control preserved `watch.enabled: false`, did not
start the service, and reported automatic refresh as unavailable. Failure
controls cover invalid config, config-write failure, service startup failure,
missing idle-deadline evidence, invalid Rust selection, and freshness that
remains stale after one bounded settling refresh.

The package fixture also found a language-discovery defect: Git discovery
included untracked `node_modules` paths when a repository had no `.gitignore`,
causing dependency `.py`, `.c`, and `.cpp` files to masquerade as project
languages. Git paths now use the same ignored-directory segments as filesystem
discovery, and a repository fixture guards the corrected TypeScript-only
result.

Final setup-integration acceptance passed 1,231 tests across 177 files, lint,
typecheck, build, generated command docs, a fresh TypeScript/Rust reindex, and
diff-gate with zero findings or advisories. The separate health baseline still
predates the broader indexing campaign and reports 165 repository-wide deltas;
it was not rewritten as part of this setup slice.

### 2026-07-10 — setup ownership and outcome-record follow-up

The post-setup integrity audit found that guided indexer/parser questions were
displayed without controlling an implementation and that installed
`hook-stop` bypassed the outcome-event recorder used by legacy hook mode. The
accepted follow-up makes indexer consent effective, removes the unsupported
parser-runtime action, classifies setup changes as repository, checkout, or
user state, and makes normal installed Stop hooks record caught-to-resolved
transitions. A real hook fixture now proves that removing a finding produces a
`resolved` event and one fixed item in `effectiveness`.

Project hooks now remain local through `.git/info/exclude`; setup refuses to
rewrite tracked provider settings, and this repository removes its obsolete
tracked `.codex/hooks.json` and `.claude/settings.json`. Suppression JSON and
`.scipquery/ledger/` remain shared repository records that generated guidance
requires agents to commit. Final run counts and package evidence are recorded
in the closure plan: 1,240 tests across 180 files, lint, typecheck, and build
passed. The 333-file packed package was 826,805 bytes at SHA-256
`a18dd564e24ef944c460cd306292079e8f93455ef0a8d80e5735711d3589df0d`;
its isolated hook install/remove smoke kept `git status` clean. The final
reindex reused the fresh generation in 0.3 seconds, and diff gate completed
with zero findings or advisories.

## Run History

Machine-readable run history:
`docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl` and
`docs/benchmarks/runs/2026-07-10-setup-integration.jsonl`.

Profile files live next to that run history with descriptive names.

## Measurements

Machine-readable measurements are in
`docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl`.

Rejected/diagnostic records are intentionally retained in that JSONL:
health-report-cache hits, tuple-batch timeouts, and stale codex-rs runs explain
why the implementation was reverted and why codex-rs parent is not a clean
acceptance corpus for this slice.

## Decisions

- Keep ts-morph as the TypeScript default until tsserver comparison proves
  parity. The 2026-07-09 full scip-query comparison found 110 mismatches and a
  slower tsserver reference pass.
- Keep `SCIP_QUERY_NATIVE_CONSUMER_CLASSIFY=1` opt-in.
- Do not keep the semantic cache read batching attempted in this campaign; it
  did not beat the existing prepared per-file reads.
- Keep full-health semantic prewarm on all semantic-supported definitions, not
  production callables only. The production-only boundary left phase-worker
  misses and erased the cold-run benefit.
- Accept durable Rust semantic-session correctness and performance eligibility.
  Readiness version 2 reproduced exact outputs and semantic payloads with zero
  incomplete Rust references across all five SynthRunnerRust and VegaAssistant
  controls, while both forward and reverse warm comparisons exceeded the 20%
  gate. Phase 6 subsequently made this eligible route the default with worker
  opt-out/failover.
- Accept the bounded live complete-response entry under the durable default
  identity. It serves only exact repeated combined requests under a
  reused identity, clears on invalidation/shutdown, and moved Vega warm full
  health below 50 seconds without changing semantic facts.
- Treat command hashes and semantic fact counts as separate acceptance gates for
  semantic-speed changes. The rejected 5s Rust timeout kept the health hash but
  dropped reference facts.
- Do not keep the direct Rust `From::from` fast path. It kept the command hash
  but changed rust-analyzer scheduling enough to lose two semantic reference
  facts elsewhere in the batch.
- Accept adaptive zero-settle only for small Rust reference-only batches and
  small combined reference+callee batches. Full zero-wait remains rejected
  because it changed SynthRunnerRust facts.
- Accept the Rust callee indexed-document guard. Dependency-file callees cannot
  resolve to project SCIP definitions, so skipping definition-catalog reads for
  those paths preserves output while cutting the callee canonicalization span
  from about 2.2s to 2ms on SynthRunnerRust.
- Accept Rust `field_identifier` source call extraction and source-facts payload
  versioning as accuracy fixes. Accept the exact source-callable zero-callee
  skip as redundant rust-analyzer request elimination, but do not count it as a
  measured wall-time speedup yet.
- Accept health semantic prewarm marker version 2 with `referenceIncomplete`.
  A prewarm with incomplete Rust reference rows may keep successful cache writes,
  but it must not mark the project reusable-warm.
