# SQL-backed command performance baseline

Date: 2026-07-28  
Revision under test: `9de38b98ac75fe0fa620d921c83911e7634e255c` plus the working-tree campaign  
Host: local macOS development host  
Machine-readable history:
`docs/benchmarks/runs/2026-07-28-sql-command-performance.jsonl`

## Measurement contract

The command baseline is an end-to-end measurement from a fresh Node process:
CLI startup, project resolution, immutable database open, query work,
source/semantic enrichment, rendering, and JSON serialization are all
included. Each command ran with the watch service disabled in the child
process so a benchmark could not create background refresh work.

The direct probes isolate one query function on an already-open
`ScipDatabase`. SQL instrumentation wraps `db.all` and `db.get`, recording
statement count, returned-row count, and wall time. Direct timings reveal
database defects that fixed CLI startup can hide.

An output is considered identical only when its ordered JSON value or stable
SHA-256 hash is unchanged. Timing alone never licenses an output change.

## Corpora

| Corpus     | Documents | Symbols | Database size |
| ---------- | --------: | ------: | ------------: |
| scip-query |       403 |  28,523 |      19.9 MiB |
| Vega_2.0   |     2,670 | 132,010 |  about 93 MiB |

Vega_2.0 is the scale corpus. It is large enough to expose project-wide
definition, mention, and document scans while still representing an ordinary
application repository.

## Initial end-to-end ranking

Two iterations per command were used for the initial 32-command matrix.
Medians are in milliseconds.

| Command               | scip-query | Vega_2.0 | Dominant work on Vega_2.0                           |
| --------------------- | ---------: | -------: | --------------------------------------------------- |
| `dead`                |    2,744.0 |  7,491.5 | candidate production and source AST fallback        |
| `affected`            |    2,144.0 |  6,803.5 | TypeScript semantic reference provider              |
| `isolated`            |    1,821.0 |  3,266.0 | candidate production and strict callee construction |
| `redundant-reexports` |    1,249.5 |  3,176.5 | repeated document reads plus broad re-export SQL    |
| `bottlenecks`         |    1,539.5 |  3,094.5 | per-symbol caller/reference SQL                     |
| `drift`               |    1,002.0 |  1,971.0 | first-fill file dependency graph                    |
| `refs`                |    1,017.5 |  1,519.5 | source/reference attribution                        |
| `trace`               |      899.5 |  1,503.0 | source/reference attribution                        |
| `dataflow`            |      851.0 |  1,487.5 | source facts and graph projection                   |

Most focused commands were between about 0.67 and 1.3 seconds end to end.
Their SQL statements completed in milliseconds or less, so their measured
floor was process and project setup rather than a database access defect.

## Confirmed SQL defects before remediation

### `redundant-reexports`

| Corpus     | Direct total |   SQL time | SQL calls | Rows returned by SQL |
| ---------- | -----------: | ---------: | --------: | -------------------: |
| scip-query |     316.8 ms |    91.0 ms |       104 |               40,178 |
| Vega_2.0   |   1,886.0 ms | 1,451.8 ms |       310 |              825,133 |

On Vega_2.0, 309 calls repeatedly loaded the indexed document set, returning
825,030 document rows. The broad SCIP re-export query separately spent about
226 ms constructing a definition map for the entire project before applying
the much smaller barrel set.

### `bottlenecks`

| Corpus     | Direct total |   SQL time | SQL calls | Rows returned by SQL |
| ---------- | -----------: | ---------: | --------: | -------------------: |
| scip-query |     836.6 ms |   211.7 ms |     4,619 |               60,238 |
| Vega_2.0   |   3,996.0 ms | 1,662.9 ms |     8,985 |              156,700 |

Vega_2.0 executed `SELECT COUNT(*) FROM global_symbols` 8,981 times and
resolved reference chunks once per candidate symbol. Both values are
generation-wide or batchable facts.

## Final retained results

The final three-iteration Vega_2.0 CLI rerun produced:

| Command               | Initial median | Final median |                         Change | Output         |
| --------------------- | -------------: | -----------: | -----------------------------: | -------------- |
| `redundant-reexports` |     3,176.5 ms |   1,335.0 ms | 58.0% faster; 2.38× throughput | identical hash |
| `bottlenecks`         |     3,094.5 ms |   1,992.0 ms | 35.6% faster; 1.55× throughput | identical hash |

The direct Vega_2.0 `redundant-reexports` function fell from 1,886 ms to a
264.8 ms median with the same result hash
`bc42b0693d91680d9574f1bfb5d927e27e2942b40192a9e9ed9b41f44ccd0f90`.
That is about 7.1× faster. Its final SQL work was two calls taking about
34 ms in the instrumented run.

The direct Vega_2.0 `bottlenecks` function fell from 3,996 ms to about
1,710 ms in the retained exact-output probe. SQL calls fell from 8,985 plus
8,981 scalar reads to 16 batched reads plus one cached strategy read.

Smaller-corpus CLI improvements were intentionally not used as the acceptance
oracle because fixed startup is a much larger fraction of their runtime.

## Residual command costs

The expanded one-iteration Vega_2.0 matrix measured every remaining bounded,
full, cleanup, health, and composite calibration command. Slow residuals were:

| Command                         |                  Time | Profiled dominant work                             |
| ------------------------------- | --------------------: | -------------------------------------------------- |
| `health --full`                 | 21,344 ms cold sample | semantic prewarm and detector composition          |
| `bench`                         |             15,724 ms | diff-gate checks and TypeScript evidence           |
| `self-audit`                    |             10,876 ms | semantic callees and TypeScript project bundles    |
| `similar --full`                |             10,472 ms | callee fingerprints and semantic callees           |
| `isolated --full`               |              8,940 ms | semantic callee provider plus candidate production |
| `plan-context`                  |              8,834 ms | `affected`, semantic references, and Git history   |
| `health`                        |  8,717 ms cold sample | multiple detector candidate pipelines              |
| `incomplete-migration --full`   |              8,137 ms | semantic callees                                   |
| `passthrough-candidates --full` |              7,791 ms | semantic callees                                   |
| `dead --full`                   |              7,477 ms | candidate production and semantic/source callers   |
| `cleanup-plan --verify`         |              7,316 ms | dead candidates plus verification                  |
| `complexity-hotspots --full`    |              6,883 ms | candidate and semantic evidence                    |
| `imports --full`                |              6,588 ms | TypeScript import-use materialization              |
| `call-graph --full`             |              6,618 ms | TypeScript semantic references                     |

These are not unoptimized SQL statements disguised by a command name.
Profiles and direct SQL instrumentation place their dominant costs in source
parsing, semantic providers, Git, detector composition, or verification.
They remain candidates for later non-SQL performance lenses.

Cold/warm health timings varied sharply after persistent evidence products
were populated. They are retained in the JSONL history but are not presented
as a SQL speedup because cache state, not this SQL campaign alone, explains
that variance.
