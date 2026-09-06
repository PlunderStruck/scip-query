---
name: scip-explore
description: Understand the live repository behavior needed to explain, plan, change, or review a system. Trace inputs through owners, decisions, transformations, effects, consumers, and recovery; disclose gaps.
---

# SCIP Explore

Load `$scip-query` for shared mechanics. Use this workflow when the answer crosses symbols or files; skip the ceremony for an exact lookup whose answer is already local.

A repository system is cooperating code and resources whose behavior turns an initiating input into observable results. An evidence ledger connects each material claim to source or execution evidence. A material claim is a fact whose truth could change the requested answer or edit.

## Establish the question

Create a small private evidence ledger from the user's question, normally three to seven initial claims. Split claims when their branches or outcomes need different evidence. Mark each `unresolved`, `established`, `unsupported`, or `excluded`; record why an exclusion cannot affect the answer.

Consider the relevant parts of the causal spine—the connected steps producing the result:

- origin and ownership: initiating surface, live implementation, owner lifetime and sharing scope;
- decisions and transformations: authorization, precedence, bounds, defaults, data reshaping, sibling outcomes;
- crossings and effects: queued work, runtime handoffs, state changes, notifications, identity, order;
- observation: returned values and the consumer making completion visible;
- failure and recovery: rejection, retries, interruption, rollback, cleanup, later maintenance.

Do not add unrelated facts merely because a file contains them. A repository overview is not evidence that every module's behavior was reviewed.

## Select the live implementation

Start with an exact referent from the request; locate one only when needed. Reuse returned symbols and file:line identities. When several implementations match, make authoritative scope the first ledger row: which implementation serves the requested entry surface and consumers?

Compare incoming execution, runtime connections, and consumers. A newer file, matching name, public export, or first search result does not establish relevance. If several paths remain plausibly live, retain separate scopes. Never edit the easiest match and silently ignore another implementation.

Use `system --source` for a first-use map and group drilldown; use indexed `system <path>`, `surface <path>`, or `context <target>` when compiler symbols and symbol consumers matter. Grouping alone does not establish business responsibility.

## Resolve remaining facts

Choose relationships that settle ledger claims, batching independent roots. Read implementations and relevant complete invocations when graph evidence cannot establish predicates or arguments. Do not search again for delivered text or symbols.

Preserve behavior-changing distinctions: parsing can fail before validation; scheduling is not execution; an enqueue is not successful consumption; a default is not a rejection. Follow durable markers and queued records to later consumers when they change observable behavior.

After each packet record covered identities/ranges, update only supported claims, and name the remaining gap. Recover available evidence when it can settle a material claim. If two consecutive packets do not settle or refine the question, reassess the root and relationship rather than collecting unrelated source.

A bounded reference list cannot establish what every caller passes. A local data slice cannot establish whole-program value history. Preserve coverage and obtain the relevant invocation/runtime evidence.

## Finish with supported behavior

Explain initiating conditions, responsible implementation, decisions, transformations, effects, results, and recovery in causal order. Audit the draft against source and ledger, repairing omissions from evidence already obtained.

Stop when all material claims are `established`, `unsupported`, or `excluded`, no contradiction remains, and no available in-scope recovery could change the conclusion. State unsupported limits. A plausible narrative or exhausted output page does not establish completion.

## Specialized support

- Read [the information model](references/information-model.md) only for a capability inventory or uncertain support. Do not load it for routine end-to-end exploration.
- When delegation is authorized and leaves useful independent work for the parent, read [delegated exploration](references/delegated-exploration.md). Delegation is not required.
- When `SCIP_EXPLORE_EVIDENCE_DIR` and `SCIP_EXPLORE_LEDGER` request external evidence mode, read [external evidence](references/external-evidence.md) and preserve its capture protocol.
