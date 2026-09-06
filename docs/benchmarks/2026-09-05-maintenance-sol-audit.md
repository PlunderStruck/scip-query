# Sol medium audit of source health and review

GPT-5.6 Sol at medium reasoning audited the first implementation on an isolated snapshot of this repository. It found three reproducible correctness defects. Each is now covered by a regression test and fixed. The task and model output are retained under [maintenance-results](../../benchmarks/maintenance-results/2026-09-05-sol-medium/metadata.json).

This was a bounded development audit, not a controlled comparison with native exploration. The prompt named six provider files and limited the final answer to three substantive findings. No effectiveness claim follows from one successful, guided audit.

| Confirmed defect | Change | Regression |
| --- | --- | --- |
| Adding only an imported target could introduce a forbidden dependency, but review filtered the finding out because its recorded site was the unchanged importer. | Architecture findings now retain both endpoints of all matching import edges, including scoped target-only changes. | `source-review.test.ts`: “reviews forbidden dependencies when only the imported target changes” |
| Explicitly supplied empty or stale coverage disappeared from health without a visible incomplete result. | Both reports summarize available/unavailable measurements. Unusable requested coverage makes the report incomplete and fails `--check` with exit 2. Source metrics remain independently comparable. | `source-review.test.ts`: “makes explicitly supplied but unavailable coverage visible in health”; CLI gate test |
| Renaming by spelling could conflate a global call with a same-named declaration in an inner block. | Body comparison uses compiler-resolved local binding identity from a single-file, in-memory program. Unrelated globals retain their names. | `function-metrics.test.ts`: “resolves local bindings by lexical identity instead of erasing global names” |

The model first ran source health and review, drained the emitted output continuations, and then inspected the named providers. The snapshot contained 514 eligible source files; the requested review scope returned four changed files and 70 function records. Watching and reindexing were deliberately disabled. The tool reported that indexed source exploration was unavailable, so the model used the explicitly allowed native exact reads for those six files. It used executable counterexamples rather than treating high complexity as proof of a defect.

The run completed successfully with 668,537 reported input tokens (620,928 cached) and 12,990 output tokens. These are the CLI's usage counters, not a dollar-cost estimate. The large accumulated context is a reason to continue measuring report size and agent query behavior; this run does not establish efficient consumption.

The frozen prompt, model transcript, final answer, tracked input patch, and added source files are retained with hashes. The tracked diff was unchanged after the audit. The transcript reports no source edits; added files were archived separately, and no pre-run hash was captured for them. No model rerun is represented as having validated the fixes: the regression tests validate the specific counterexamples.

Next evaluation should compare native and tool-assisted runs on unlabeled first-use discovery, reuse planning and review tasks, with both genuine defects and legitimate similar implementations. It must measure preserved behavior, useful findings, false positives, latency and tokens—not just command use or metric reduction. The earlier [small change pilot](2026-09-05-change-pilot.md) remains a separate development baseline.
