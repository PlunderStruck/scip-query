# SQL Performance Baseline

Date: 2026-07-27  
Revision: `9de38b98ac75fe0fa620d921c83911e7634e255c`  
Host: local macOS development host  
Purpose: directional before/after evidence for the SQL-performance remediation

These measurements isolate SQLite statement execution on already-open,
already-warm databases. They are not end-to-end CLI latency service-level
objectives. Each candidate query was checked for identical ordered rows or an
identical stable row hash before its timing was retained.

## Corpora

| Corpus | Documents | Symbols | Mentions | Database size |
| --- | ---: | ---: | ---: | ---: |
| scip-query | 400 | 28,448 | 94,685 | 19.8 MiB |
| Vega_2.0 | 2,670 | 132,010 | 374,806 | 93.3 MiB |

Vega_2.0 contained 112,362 role-one definition mentions and 262,444
non-definition mentions. This distribution is why a definition-only partial
index is materially smaller than either the table or a full role-leading
index.

## Baseline command smoke

`scip-query bench --json` before source edits reported:

| Probe | Duration |
| --- | ---: |
| status JSON | 982 ms |
| status capabilities | 958 ms |
| capabilities | 870 ms |
| capability matrix | 867 ms |
| stats | 549 ms |
| kind counts | 547 ms |
| diff impact | 874 ms |
| diff gate | 1,968 ms |

These command timings are retained as a broad regression smoke test. The
remediation targets the SQL statements below rather than claiming all CLI
startup and runtime work will improve by the same ratio.

## Query-shape probes

| Workload | Corpus | Current | Candidate | Directional change |
| --- | --- | ---: | ---: | ---: |
| whole definition map | scip-query | 10.118 ms | 5.231 ms partial index; 4.659 ms after `ANALYZE` | 2.2× faster |
| whole definition map | Vega_2.0 | 53.001 ms | 30.762 ms partial index; 29.528 ms after `ANALYZE` | 1.8× faster |
| targeted `deps` | scip-query | 24.380 ms | 0.051 ms target-first | 478× faster |
| targeted `deps` | Vega_2.0 | 111.060 ms | 0.531 ms target-first | 209× faster |
| targeted `deps` plus partial index | Vega_2.0 | 111.060 ms | 0.280 ms | 397× faster |
| targeted `rdeps` | scip-query | 7.056 ms | 0.375 ms target-first | 18.8× faster |
| targeted coupling | scip-query | 23.228 ms | 0.142 ms target-first | 163.6× faster |
| exact file-range lookup | scip-query | 0.209 ms | 0.004 ms exact path | 52.3× faster |

The partial index took approximately 4.9 ms to build on scip-query and 22 ms
on Vega_2.0. The complete maintenance pass including `ANALYZE` took
approximately 23.6 ms and 100.4 ms respectively. That one-time publication
cost is small relative to repeated interactive queries.

## Rejected index

`(role, symbol_id, chunk_id)` was rejected. Before statistics existed, SQLite
selected its role prefix for a targeted Vega_2.0 dependency lookup and
regressed the statement from 0.531 ms to 74.684 ms. `ANALYZE` corrected that
specific plan, but a safe physical design should not require statistics merely
to avoid a catastrophic exact-lookup regression. The accepted candidate is
the definition-only partial index led by `symbol_id`.

## Acceptance targets

- no changed ordered rows or result hashes;
- no target-specific query plan that begins from every global symbol or every
  project definition;
- at least 1.5× improvement for the whole definition map on both corpora;
- at least 10× improvement for target-specific dependency and coupling probes
  on the larger corpus where applicable;
- exact file-range lookup uses document and range indexes;
- the one-time layout upgrade does not invoke an unchanged language indexer.

