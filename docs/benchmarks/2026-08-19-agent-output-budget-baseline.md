# Agent output budget baseline — 2026-08-19

## Decision

A client-safe output page is one model-facing CLI response whose complete UTF-8 text reaches the agent through the Codex tool harness. It is a transport page, distinguished from a query result by carrying only a recoverable slice of that result.

The current desktop harness truncated a controlled terminal result at 10,000 tool-output tokens. OpenAI's public Codex documentation does not publish this per-tool-result ceiling, so 10,000 is an environment measurement, not a product-wide contract. This campaign uses 8,000 UTF-8 bytes as the conservative client budget.

## Baseline

Built from `main` before this campaign. Each command was run with `--output-page-size 100000` and measured in memory so the existing 32,000-character default would not hide total renderer cost.

| Scenario                  |  Bytes | Lines | Largest line | Request | Identities | Source | Calibration | Coverage | Recovery |
| ------------------------- | -----: | ----: | -----------: | ------: | ---------: | -----: | ----------: | -------: | -------: |
| `search output-page-size` | 17,564 |    78 |        9,209 |      63 |      1,588 | 11,999 |         320 |      577 |    2,881 |
| small source search       |  1,660 |    25 |          360 |      72 |        196 |    390 |         320 |      512 |       88 |
| small exact `code` read   |  1,226 |    23 |          142 |      65 |          — |    641 |         309 |      151 |        — |

The broad search spent 21.5% of its bytes on calibration, coverage, and recovery. Its largest avoidable unit was a 9,209-byte single-line JSONL preview. Its recovery manifest also repeated paths and owners already present in the identity section.

The unpaged machine path was a separate failure. `search output --json
--result-only` rendered 11,094,406 bytes for 16,981 exact identities. A direct
model-facing run was truncated by the desktop harness despite scip-query's
stderr warning, because the warning did not stop stdout from streaming. The
harness reported 2,759,865 original tokens during that probe. This establishes
that a warning and an optional paging flag cannot make raw JSON safe for model
context.

## Output identity contract

- Exact match counts, file/line identities, source freshness, omissions, and recovery scopes must remain true.
- Machine-readable JSON result bytes remain unchanged unless the caller explicitly requests pagination.
- Human overlong-line previews may be shortened only when the exact match identity remains visible and `scip-query code path:line-line` can recover the line.
- Concatenating cursor page content must reproduce the complete rendered result byte-for-byte.

## Alternatives

1. Lower only the character page size. Rejected because character counts do not bound UTF-8 bytes, JSON escaping, or model tokens, and it merely spreads redundant text across more calls.
2. Add an MCP/plugin adapter. Rejected as a truncation fix because a controlled MCP result was retained in raw events but truncated before model context at the same harness boundary.
3. Shape the result, then apply byte-bounded cursor transport. Selected because it removes needless material while keeping complete recovery and works for CLI, MCP, or any later adapter.

## Primary hypotheses

- A hard byte ceiling at the snapshot writer will keep every human page under the harness cap without changing result identity.
- Bounded long-line previews will remove the dominant broad-search payload while preserving the matched referent.
- A complete top-level recovery manifest will retain structural recovery with far fewer repeated rows than the adaptive deep manifest.

## Accepted result

| Scenario                    |       Before |    After |  Change | Pages | Largest page |              Largest rendered line |
| --------------------------- | -----------: | -------: | ------: | ----: | -----------: | ---------------------------------: |
| `search output-page-size`   |     17,564 B |  6,075 B |  -65.4% |     1 |      6,075 B |                              511 B |
| small source search         |      1,660 B |  1,429 B |  -13.9% |     1 |      1,429 B |                              360 B |
| small exact `code` read     |      1,226 B |  1,125 B |   -8.2% |     1 |      1,125 B |                              138 B |
| bounded behavior inspection | not recorded | 22,025 B |     n/a |     5 |      6,739 B | 9,766 B reconstructed across pages |
| agent JSON broad search     | 11,094,406 B |  4,402 B | -99.96% |     2 |      4,447 B |                            4,401 B |

The broad search now fits in one client-safe response. The behavior inspection remains larger because 18,715 bytes are selected behavior facts; cursor transport bounds each response without deleting that evidence.

The JSON comparison uses the same broad `output` selector. `--agent-output`
retained exact total/omitted counts, 64 representative identities, scope
recovery hints, text coverage, and materialization counts while keeping both
responses below 8,000 bytes. `--json-output` separately wrote and verified all
11,094,406 bytes through an atomic file without placing them in model context.
