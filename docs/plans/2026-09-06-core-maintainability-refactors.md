# Core maintainability refactors

The user authorized addressing the four assessed concerns from the scanner self-audit: duplicated legacy lock decoding, graph file-frontier expansion, SCIP-to-SQLite conversion, and query-service request decoding. This is not an instruction to eliminate every repository complexity warning. Work on main and preserve the unrelated untracked LaunchPoint validation report. No subagents are authorized.

## Required repository facts and preserved behavior

- Both legacy PID decoders feed the common process-file-lock implementation. Preserve positive safe-integer validation and the distinct generic/shared-generation lock paths, timing, ownership and completion outcomes.
- Graph expansion is called by the system-map traversal. Preserve relationship-policy gates, source scopes, depth, call/reference distinction, evidence strength, attribution, compiler-call deduplication, service-consumer tracking and boundary promotion. Helpers must express coherent relationship responsibilities and share only the state they require.
- The converter has ordered document/symbol and occurrence passes within one data transaction, followed by index creation. Preserve wire parsing, duplicate rules, symbol/row identities, enclosing-range validation, counters, cancellation/yield points, rollback, database closure and measured prepared-insert performance.
- Query-service decoding validates shared mailbox/session metadata before request-specific fields. Preserve protocol/session checks, deadline ordering, generation, selector limits, accepted request variants, defaults, returned fields and errors.

## Work

- [x] Establish exact owners, consumers, existing behavioral tests and necessary additional checks for all four areas.
- [x] Consolidate the legacy lock-record decoder into its common owner; verify both consumers and malformed legacy data.
- [x] Separate graph file-frontier expansion into relationship-specific operations with explicit state and preservation tests.
- [x] Separate converter phases while keeping transaction and resource lifecycle ownership clear; verify equivalence, failures, interruption and representative performance.
- [x] Separate common envelope validation from request-specific decoding; verify every supported kind and rejected malformed inputs.
- [x] Run focused and required broad checks, build/API/type/lint checks, source diff review, architecture checks and qualified diff impact.
- [x] Record final results and deliver the scoped change on main.

For each area, record what repeated knowledge or coordination disappears and any justified behavior retained. Do not loosen detector thresholds, suppress findings, change architecture allowances, or introduce a parallel implementation. Every existing branch need not disappear; the goal is clearer ownership with equivalent observable behavior.

## Implementation progress

All four changes are implemented and validated.

- `process-file-lock.ts` owns `decodeLegacyPidLock`; cache and shared-generation acquisition retain their separate waiting/readiness contracts.
- File graph expansion now has compiler, member-call, and import phases. One per-file attribution function resolves source symbols, source constructs, and runtime observations; compiler calls still establish deduplication keys before reference/member traversal.
- Conversion has separate declaration/occurrence readers and normalizers, a per-conversion writer owning prepared statements and IDs, and a common ordered document visitor. The public operation owns the transaction and connection lifetime.
- `query-service-envelope.ts` owns decoding, with a compile-time exhaustive registry for all 20 request kinds. The server imports its decoder. The new file belongs to the existing runtime boundary; dependency permissions are unchanged.
- Existing focused suites: 184 passing before/after the three larger refactors. Added 65 protocol cases, 8 malformed-lock cases, and 3 conversion interruption/forward-declaration cases pass. Typecheck passes.
- Before/after decoder differential comparison: 7,107 cases produce identical normalized values or exact errors.
- Converter baseline was bundled before editing. A deterministic 600-document / 240,000-occurrence fixture compares statistics and hashes of every table, including compressed occurrence bytes and IDs, across three alternating old/new runs. Final measurements and full-suite/review results will be recorded below.

### Additional finding from the full suite

The first full run passed 2,999 / 3,000 tests. The existing source import cycle contract failed on `function-metrics.ts` → `maintenance-bindings.ts` → (type-only) `function-metrics.ts`. This cycle predates the four refactors and was identified in the self-audit. Fix: move the compiler binding-pattern name reader into its existing primary consumer, `source/ast/function-metrics.ts`, and point the slice reader there. This removes the reverse dependency without weakening the test or copying types.

The source module has an explicit 67-file bound. Keeping binding-name extraction with the existing function-analysis owner removes the cycle without adding a file or relaxing that bound. No metric thresholds, suppression records, dependency allowances, or file limits were changed.

## Final source review and equivalence results

- Current-source review: all 561 eligible TS/JS files analyzed and mapped; 47/47 explicit dependency policies; no source dependency cycles, introduced/worsened findings, or blocking violations. Four previous findings resolve (three complexity hotspots and one duplicate body group). Ten unrelated findings remain uncomparable to the base; this review does not claim those are clean.
- Remaining repository maintenance debt: 649 complexity findings and six duplicate body groups. This change addresses the four selected areas, not every historical finding.
- Original coordinator cyclomatic/cognitive measurements: file frontier 63/167 → 2/1; converter 69/134 → 6/5; envelope decoder 80/65 → 6/4. All changed/extracted functions in these areas are also below the unchanged thresholds: maximum 10/13 for graph, 9/12 for conversion, and 10/8 for protocol decoding. These measurements support the responsibility split; they do not establish correctness by themselves.
- Decoder registry is exhaustive over all 20 protocol request kinds at compile time. The 7,107-case baseline comparison preserves decoded fields, omission of optional fields, malformed-input rejection, and exact error strings. Permanent tests cover each kind, required fields, options, selector bounds, envelope identity/timestamps, and prototype-key rejection.
- Converter comparison uses 600 distinct documents plus one duplicate, 240,000 surviving occurrences, 600 merged occurrences, 601 dropped illegal occurrences, 1,200 chunks, 4,800 mentions, 600 symbols, and 600 enclosing ranges. Every table's rows, assigned IDs, compressed chunk bytes, and returned statistic match the baseline across three alternating runs. Fixture size: 14.3 MB. Median conversion time: 142.2 ms before, 137.1 ms after. This small deterministic experiment shows no observed regression; it is not a general performance claim. The existing independent Go-converter parity test passes.
- Permanent interruption tests abort during both declaration and occurrence passes and verify all five tables roll back and the database can acquire another transaction. A forward-declaration case verifies that later document declarations are available to earlier enclosing ranges.
- Build, typecheck, formatting, changed-file ESLint, public API contract, public consumer compilation, skill links, and Git whitespace validation pass. The public API remains `88ac6629033f84f6` across 66 paths.
- `diff-impact` remains qualified: seven indexed changed symbols and four affected files; seven paths are absent/excluded from that index, including the newly created decoder and non-source files. The complete current-source review, not this partial index report, establishes structural coverage. No full semantic-consumer claim is made.

Final full-suite result: **3,000 tests passed across 343 test files**, against the completed, unchanged build. Delivery is recorded by the commit containing this document.

Validation sequencing note: a second full run passed 2,998 tests but two source-review CLI cases overlapped a rebuild started during the run; one explicitly failed because its old generated chunk had been removed. This was an execution-order error during verification. The final rerun against the completed, unchanged build passed all 3,000 tests.
