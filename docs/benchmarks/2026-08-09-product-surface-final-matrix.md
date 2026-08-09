# Product-surface final benchmark matrix

Date: 2026-08-09

## Decision

Do not publish this tree as a new release on the strength of the exploration benchmark. The operational implementation is validated, and treatment recovers more strict material facts in aggregate, but one final held pair loses a fact and treatment uses substantially more total tokens across the matrix. This fails the program's rule that a per-task accuracy regression must be investigated rather than averaged away.

The surviving exact claim is: for these eight fixed treatment/control pairs, scip-query reduced rendered repository evidence by 39.3% and recovered 22 strict compound facts versus 19, while increasing total model tokens by 59.3% and uncached input by 3.7%. That establishes evidence compression, not token compression or per-task accuracy non-inferiority.

## Conditions

- Treatment CLI tree: `7cba8b1c` plus the benchmark record added after the runs.
- TypeScript repository: `arxiv-agent-cli` at `d25b1fa2308627a23040946a043e661d96e38e2e`.
- Rust repository: `agentic_cad` at `cc206b1`.
- Models: `gpt-5.6-luna` with `max` reasoning and `gpt-5.6-sol` with `medium` reasoning.
- Prompt shapes: one open-ended and one specific question over the same frozen seven-fact rubric in each repository.
- Isolation: detached worktree per arm; treatment received a private fresh index and scip-query-only tracked-text exploration; control received native reads and no scip-query executable.
- Cleanup: every runner completed with exit status zero and removed its detached worktree and private cache.
- Manual score: all seven frozen facts are compound. Credit requires the answer itself to state every material conjunct; citations and implications do not fill an omitted clause.
- Automatic score: reproducible literal-bundle diagnostic only, not the accuracy gate.

## Results

| Model | Task | Arm | Manual | Auto | Total tokens | Uncached input | Output | Rendered evidence | Calls | Native reads | Seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Luna | TypeScript open | treatment | 2/7 | 1/7 | 1,249,480 | 70,995 | 14,965 | 118,785 | 25 | 0 | 315.0 |
| Luna | TypeScript open | control | 3/7 | 1/7 | 513,057 | 80,032 | 10,625 | 421,967 | 62 | 62 | 201.8 |
| Luna | TypeScript specific | treatment | 4/7 | 4/7 | 510,037 | 75,699 | 13,218 | 133,857 | 10 | 0 | 266.3 |
| Luna | TypeScript specific | control | 3/7 | 2/7 | 915,215 | 80,054 | 11,097 | 237,648 | 23 | 23 | 225.4 |
| Luna | Rust open | treatment | 1/7 | 1/7 | 1,944,217 | 87,554 | 16,791 | 149,301 | 39 | 0 | 386.0 |
| Luna | Rust open | control | 1/7 | 0/7 | 809,245 | 80,113 | 13,868 | 233,058 | 41 | 41 | 268.5 |
| Luna | Rust specific | treatment | 2/7 | 0/7 | 803,031 | 92,292 | 17,491 | 209,661 | 37 | 0 | 349.6 |
| Luna | Rust specific | control | 2/7 | 1/7 | 666,300 | 76,353 | 14,459 | 274,577 | 25 | 25 | 274.0 |
| Sol | TypeScript open | treatment | 5/7 | 1/7 | 357,169 | 53,750 | 5,691 | 117,971 | 7 | 0 | 138.2 |
| Sol | TypeScript open | control | 3/7 | 1/7 | 264,345 | 60,220 | 2,909 | 169,115 | 5 | 5 | 74.0 |
| Sol | TypeScript specific | treatment | 4/7 | 2/7 | 363,456 | 68,910 | 5,266 | 90,349 | 8 | 0 | 142.9 |
| Sol | TypeScript specific | control | 4/7 | 3/7 | 300,198 | 68,660 | 2,930 | 129,581 | 6 | 6 | 69.7 |
| Sol | Rust open | treatment | 3/7 | 1/7 | 619,363 | 64,726 | 5,261 | 141,838 | 11 | 0 | 160.1 |
| Sol | Rust open | control | 2/7 | 1/7 | 356,943 | 54,713 | 5,270 | 190,607 | 15 | 15 | 127.2 |
| Sol | Rust specific | treatment | 2/7 | 1/7 | 696,879 | 59,318 | 6,009 | 123,316 | 18 | 0 | 175.7 |
| Sol | Rust specific | control | 1/7 | 0/7 | 282,627 | 52,658 | 3,409 | 130,274 | 6 | 6 | 85.8 |

Totals:

- Treatment: 22/56 strict facts, 6,543,632 total tokens, 573,244 uncached input, 84,692 output, 1,085,078 rendered characters, 155 exploration calls, zero native tracked-source reads.
- Control: 19/56 strict facts, 4,107,930 total tokens, 552,803 uncached input, 64,567 output, 1,786,827 rendered characters, 183 native exploration reads.

## Per-pair accuracy decision

- Luna TypeScript open: treatment loses 2/7 to 3/7. This is the blocking pair.
- Luna TypeScript specific: treatment wins 4/7 to 3/7.
- Luna Rust open: parity at 1/7 after the answer-audit correction.
- Luna Rust specific: parity at 2/7.
- Sol TypeScript open: treatment wins 5/7 to 3/7.
- Sol TypeScript specific: parity at 4/7.
- Sol Rust open: treatment wins 3/7 to 2/7.
- Sol Rust specific: treatment wins 2/7 to 1/7.

## Investigation of the blocking pair

The TypeScript-open treatment had statement-complete source for the persistence owner, but its final answer compressed distinct branches into phrases such as “handles active duplicates.” It omitted the explicit delete-and-return behavior that the control stated, so the loss is genuine under the frozen rubric.

Two general instruction corrections were tested:

1. Require the final prose itself to state every ledger conjunct rather than relying on implication or citations. This brought the Luna Rust open pair from a 0/7 treatment loss to 1/7 parity.
2. Require separate ledger rows for each material behavior-changing branch and terminal outcome rather than one row per function. The final TypeScript-open rerun still scored 2/7 and used 1,249,480 tokens.

The remaining loss therefore cannot be honestly described as fixed. Further prompt tuning against this task would risk benchmark overfitting. The next investigation should vary the mechanism rather than add more prose: make statement-complete behavior packets expose a compact, mechanically checkable terminal-outcome inventory that the agent must either carry into the answer or explicitly exclude. That hypothesis requires a new preregistered task set before implementation.

## Operational proof completed separately

- Full tests and lint/API/public-consumer/skill-link gates are rerun on the final tree before packaging.
- Cache-lifecycle soak completed successfully.
- Default setup completed in 8.69 seconds without health; explicit-health setup completed in 22.10 seconds.
- A valid suppression write completed in 0.31 seconds without invoking health or reindex; the probe record was deleted afterward.
- Isolated skill smoke installed and removed 15 owned links without touching the user's real home.
- Architecture passes after declaring the new `queries-health -> domain` provider-contract dependency.
- TLA focused suite passes 111/111; default help is 3,125 bytes versus 13,417 bytes for `--help-all`; obsolete retired-system models are absent from the package.
