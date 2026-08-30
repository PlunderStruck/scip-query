# External evidence mode

External evidence mode separates complete repository observations from the smaller claim evidence kept in the model's active context. A raw evidence packet is the exhaustive JSON result written by scip-query. An evidence receipt is the bounded, model-facing projection of that same result together with its coverage, observation identity, file path, byte count, and checksum.

Use this mode only when `SCIP_EXPLORE_EVIDENCE_DIR` and `SCIP_EXPLORE_LEDGER` are set. The surrounding runner owns those paths and the later context checkpoint; their presence in the task is sufficient, so do not query `env` to reconfirm them. One evidence directory belongs to one read-only acquisition snapshot. Do not reuse it after a tracked-source edit or known index-generation change; start a new directory and ledger or delta. Receipt reuse is limited to the latest compatible observation identity already present in the directory, but the read-only snapshot boundary is what prevents the first request after an unseen external change from reusing stale evidence.

The supported checkpoint uses two model contexts. The acquisition context receives bounded receipts and writes the ledger; a fresh synthesis context receives only the question and that ledger. Writing evidence to Markdown inside one continuing context does not remove earlier tool results or receipts from that context. A one-context runner may still use capture to reduce each tool result, but it must not describe that as context eviction or expect the ledger to lower already accumulated input.

## Capture evidence

Run every scip-query exploration command through the installed capture script:

```bash
node <loaded-scip-explore-skill-directory>/scripts/capture-evidence.mjs --id <unique-id> -- <command> <arguments...>
```

Replace the directory placeholder with the absolute directory containing the `scip-explore` `SKILL.md` you actually loaded. Do not guess that the skill is repository-local; Codex, Claude, and shared-agent installations may expose different absolute roots.

Use a distinctive literal already present in the task or a prior receipt, not a broad topic word:

```bash
node <loaded-scip-explore-skill-directory>/scripts/capture-evidence.mjs --id locate-root -- search '<exact identifier or message>'
```

Arguments after `--` are ordinary scip-query arguments without the `scip-query` executable. Do not add `--json`, `--agent-output`, `--json-output`, or pagination flags; the script owns transport. It writes the complete JSON envelope under `SCIP_EXPLORE_EVIDENCE_DIR` before it returns a receipt. It never pipes the result through `head`, `tail`, `jq`, or another shortening stage. A search receipt groups every identity present in the exhaustive packet into a complete file-owner-line manifest and keeps only the freshness states needed to calibrate those identities; verbose per-file proofs and binary-path inventories remain in the checksum-addressed raw packet. A command-rendering identity budget may report omissions even when the exhaustive packet contains the known total; the receipt promotes coverage only when raw identity count, known total, and matching-line count agree exactly. Otherwise an incomplete identity manifest, an overlarge model projection, or any other inability to represent the requested observation safely produces a refusal and keeps the complete raw packet for audit. Narrow or follow the stated recovery under a new evidence id; never treat the refusal as evidence.

The file export is the pagination-safe transport for external evidence mode: the command completes its exhaustive machine payload outside the model-facing terminal, then the wrapper reads that complete file. Outside this wrapper, every printed `Continue exactly:` command remains mandatory. Run each cursor unchanged until none remains before interpreting that command. Do not substitute a fresh query, alter cursor flags, or infer completeness from one page.

The wrapper compares each request with successful receipts in the same evidence directory. An exact duplicate returns `already-captured` with the receipt ids to cite and does not run scip-query again. A `code file:start-end` range already covered by either a code receipt or an exact inspect slice does the same. A partially covered range returns `overlap-requires-uncovered-query` and the exact uncovered selectors; capture only those selectors under a new id. These responses reuse already delivered bytes without deleting or approximating evidence. Prevent the response in the first place: after every receipt, record its normalized request and delivered source intervals in the private ledger; before every capture, check exact-request reuse and subtract covered intervals. Do not ask the wrapper to rediscover that a request is redundant.

Batch independent facts as one acquisition wave when the tool interface supports concurrent calls, but keep one complete raw packet and one receipt per command. Give each command its own id. Batching means issuing independent lossless transports together; it never means concatenating their terminal output, sharing a cursor, or clipping any result to fit a combined budget.

Do not read a raw packet merely because it exists. The receipt is the delivered evidence. A raw packet is for deterministic audit or a specifically named field that the receipt reports as omitted; audit only a count, identity, digest, or other non-source fact programmatically. Never print raw source, result arrays, or a raw field through `jq`, Python, `head`, `tail`, or another native command. If omitted source can change a ledger row, issue the receipt's bounded recovery query. A receipt may refer to an earlier receipt for an identical observation checkpoint while preserving its own observation time and identity hash; resolve that reference when checking snapshot compatibility instead of requesting the checkpoint again.

An `inspect --view behavior` receipt keeps every exact source slice once, plus compact unit, binding, coverage, visible-frontier, and recovery metadata. Duplicate behavior-line encodings and withheld frontier lead objects stay in the raw packet; their counts and exact `remainingInspectCommands` stay visible. Read the delivered slices as source evidence and follow a remaining command only when a named claim depends on its withheld frontier. Do not request the same source again with `code`.

`code` has no smaller safe projection: its exact source is the evidence. Prefer `inspect --view behavior` for predicates and use `code` only for a named, narrow range whose syntax can change a ledger row and is not already covered by an inspect slice or code receipt. A rejected overlarge projection is a signal to narrow the source question, not to print the raw packet.

## Write the checkpoint ledger

Keep the ordinary private evidence ledger while exploring. At the end of the evidence phase, write one self-contained Markdown ledger to the exact `SCIP_EXPLORE_LEDGER` path. This is the only repository understanding carried into the fresh synthesis phase, so preserve claim-sized evidence rather than a narrative summary.

Begin the ledger with:

- schema `scip-explore-ledger/v1`;
- handoff kind `base` or `delta`;
- the exact task and scope;
- a scope manifest listing every plausibly live production scope exposed by complete locator identities, with status `established`, `unsupported`, or `excluded` and exact authority evidence for any exclusion;
- state `complete` or `blocked`;
- every receipt id and raw-evidence checksum used;
- the observation identities and stability proofs reported by those receipts;
- for a delta, the base-ledger checksum plus every invalidated or superseded claim id.

`complete` means every material row is `established`, `unsupported`, or `excluded` and all receipts used for one claim are compatible with the declared snapshot. Use `blocked` when acquisition cannot produce a trustworthy terminal ledger. Do not silently omit an oversized projection, incompatible observation identity, changed snapshot, or unresolved material clause.

For an unqualified product question, a production scope cannot be excluded merely because another scope has a direct caller or a more complete causal spine. Either explain every plausibly live scope to the requested depth, establish exact product routing that makes one irrelevant, or return `blocked` so a targeted delta can settle it. Naming an unexplored live scope in a limitation does not make a ledger complete.

Do not classify a reachable selection formula, bound, or downstream representation consumer as non-material when it changes the user's requested behavior. In particular, a named budget helper requires its exact arithmetic, and a persisted reduction marker requires the later consumer's exact model-facing result. A delivered identity or recovery command capable of establishing either keeps the row unresolved until it is read.

For every material row include:

- an atomic claim identifier and status;
- the complete established claim, including every material guard, default, bound, field operation, ordering rule, sibling outcome, cleanup, and failure behavior;
- a `Must transfer` list with one bullet for every independently material clause that fresh synthesis must state; preserve distinct operations such as inject, replace, and transform as distinct bullets;
- for an input boundary, separate decoding or parsing failure from validation failure and cite the handler for each; a validator does not catch a failure raised while its argument is being produced;
- exact `file:line` or compiler-symbol citations present in delivered receipts;
- evidence strength and coverage limitations;
- unresolved, unsupported, or excluded clauses stated separately.

For deferred work, state the creation event, the later processing event, and whether processing occurs before ordinary work. For filtering, summarization, or pruning, distinguish durable storage from the model-facing view and state explicitly whether original history or output is deleted.

Do not cite the temporary raw-packet path as repository evidence. Do not answer the user's question in the evidence phase. After writing the ledger, return only the control signal required by the runner so it can decide whether a fresh synthesis context is permitted. Benchmark runners use exactly `LEDGER_READY` for a complete ledger or `LEDGER_BLOCKED` for a blocked ledger; delegated live exploration uses the path-bearing form in [delegated-exploration.md](delegated-exploration.md). Never append an explanation to either signal.
