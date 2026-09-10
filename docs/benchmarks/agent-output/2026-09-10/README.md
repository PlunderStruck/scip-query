# Agent output measurements — 2026-09-10

Compared accuracy checkpoint `5d2524eb` with the efficiency changes through `48791208`. These are fixed CLI fixture outputs and an isolated transport test. No coding-agent benchmarks or model requests were run.

## Human command output

Token counts use tiktoken 0.11.0 and `o200k_base`. The machine report also contains `cl100k_base` counts. These count text pieces in those encodings, not a promise about another model’s tokenizer or billing.

| Command | Bytes before → after | Tokens before → after | Token reduction |
| --- | --- | --- | --- |
| `code` | 693 → 235 | 182 → 73 | 59.9% |
| `outline` | 645 → 101 | 178 → 41 | 77.0% |
| `search` | 1,938 → 928 | 543 → 263 | 51.6% |
| `evidence` | 5,088 → 496 | 994 → 162 | 83.7% |
| `health` | 3,074 → 426 | 588 → 88 | 85.0% |
| `system` | 3,764 → 668 | 791 → 156 | 80.3% |
| `entrypoints` | 367 → 62 | 82 → 10 | 87.8% |
| `--help` | 3,718 → 3,454 | 720 → 660 | 8.3% |

The eight example responses total 4,078 → 1,453 tokens (64.4% fewer). The relationship fixture still reports exactly the expected three candidate callees, and the module overview still reports both groups and their dependency. Quality CLI regressions independently retain actual cycle, complexity, duplication, missing-coverage and incomplete-scan behavior. Healthy empty reports account for part of the large `health` reduction.

## Instruction overhead

| Instruction | Tokens before → after |
| --- | --- |
| `AGENTS.md` | 2,241 → 653 |
| `skills/scip-query/SKILL.md` | 1,185 → 1,036 |
| `skills/scip-explore/SKILL.md` | 938 → 657 |
| `skills/scip-plan/SKILL.md` | 1,658 → 1,668 |

Only the managed scip-query block is counted for AGENTS.md. The planning skill retains its requirements to map the existing central path, compare related features and document reuse; its size was not reduced at the expense of those requirements. These instruction files are not assumed to be loaded together.

## Oversized output

The same 85,383-byte synthetic relationship report was passed through the actual old and new output transport implementations. Both preserved every byte. The old default needed 14 responses and 13 continuation calls to retrieve its full stream. The new default emitted one 1,791-byte preview/path response and saved the complete file, with zero continuation calls. The first response was 2,016 → 564 tokens.

Retrieving every old page emitted 26,210 tokens in total. The new preview emitted 564 tokens; reading the saved file later would add the text selected by the reader. These are transport observations, not measured model-turn or end-to-end savings. One shell call can contain several actions; one model request can receive several tool results. No session billing data was collected, so cached input, uncached input, total request cost, task completion quality and the cost of later file reads remain unmeasured.

## Command audit and verification

The catalogue contains 86 registered commands: 81 visible and 5 hidden compatibility controls. No command was removed in this series. Ordinary help promotes `system`, `context`, `evidence`, `health`, `review`, `diff-impact` and `architecture`. The [catalogue](commands.json) records every ID by category. The presentation audit followed their shared list/table/group/report owners and the specialized source, graph, planning, module and quality renderers; it is not a new semantic-accuracy certification of all commands.

- Small list/table/reference outputs retain exact identities and locations.
- Source reads omit duplicated request metadata, success footers and unsolicited constant/adjacent-source expansions. `--bindings` requests constants explicitly.
- Search prints selected source windows once, with actual omissions disclosed; the complete machine identity data is retained.
- Graph edges retain strength, endpoints, subtype and semantic qualifiers. Inventory and provider contracts are explicit.
- Module overview shows groups and dependencies; selecting a group opens its files/exports/imports.
- Source quality reports retain findings and actual failures without repeating generic interpretation instructions.
- JSON contracts, file redirects, explicit pagination, session opt-in behavior and command exit statuses remain supported.

Final full-suite verification: **3,807 tests passed across 416 files**. Build, types, lint, format, skill links, generated documentation and 66 public API paths also passed. The initial run had two obsolete skill-text assertions and a watcher cleanup timing failure; the assertions were updated, the watcher test passed alone, and the subsequent complete run passed without that failure. No production watcher behavior changed. See the [implementation plan](../../../plans/2026-09-10-efficient-agent-workflows.md).

## Reproduction

Build the checkout, then run `npx vite-node scripts/measure-human-output.ts /tmp/scip-query-output-measurements`. The script uses the same deterministic fixture as the CLI accuracy tests. Raw before/after responses are stored next to [measurements.json](measurements.json); tokenize their UTF-8 text with the recorded tiktoken version/encodings to reproduce the table. Temporary paths and random saved-file identifiers can change a few receipt tokens. The synthetic transport report is 1,200 lines of `[candidate] callerN @ src/service.ts:N+1 -> callee @ src/shared.ts:1`; tests/runtime/output-pagination.test.ts checks its underlying lossless storage, Unicode handling, expiration, quotas, failure cleanup and compatibility transport.

Do not compare historical forced-scip-query exploration trials directly with the revised ordinary-source workflow. Their restrictions and evidence-ledger protocols describe a different experiment.
