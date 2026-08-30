---
name: scip-explore
description: Understand a repository system end to end before explaining, planning, changing, or reviewing it. Use when the task depends on how behavior enters the system, branches, transforms data, crosses runtimes, changes state, reaches consumers, or recovers from failure across multiple symbols or files. Apply scip-query as the evidence instrument; this skill owns the system model, evidence ledger, synthesis, and stopping test. Skip it for a single exact source lookup whose answer is already local.
---

# SCIP Explore

A repository system is the set of cooperating code, runtime mechanisms, and state resources whose coordinated behavior turns an initiating input into observable consequences. To understand one end to end is to reconstruct that behavior from its initiating boundary through every material decision, transformation, handoff, state change, result, and recovery path within the user's scope.

`$scip-query` is the sensing skill: it locates exact referents, projects typed relationships, reads implementation, and reports evidence strength and coverage. Load it before querying. This skill is the investigation skill: it decides which facts the answer must establish, integrates the observations, and decides when the system is understood well enough to answer. Do not duplicate the command manual here or treat either skill as a fixed command sequence.

## Build the proof target

Before querying, restate the user's question as a checkable capability or decision. Then create a small private evidence ledger. An evidence ledger is a working record whose rows bind each material claim to the evidence needed to settle it. A material claim is a repository fact whose truth could change the requested explanation, decision, plan, or edit.

Start with three to seven rows, normally one for each distinct clause in the user's question. A row must be atomic enough that one status applies to every part of it. Split a row when different predicates, outcomes, fields, bounds, or failure paths require different evidence. Do not add rows merely because an unrelated implementation exposes more behavior.

Give each row one status:

- `unresolved`: no sufficient evidence yet;
- `established`: exact or adequately calibrated evidence supports the claim within stated coverage;
- `unsupported`: a named provider or source limitation prevents the claim;
- `excluded`: the claim cannot change the requested answer, with the reason recorded.

Derive rows from the question, not from a generic checklist. For an end-to-end behavior, test whether the answer depends on these five parts of the causal spine:

1. origin and ownership — what initiates the behavior, which entry surface receives it, and which long-lived or per-invocation owner controls it;
2. decisions and transformations — which predicates, authorization checks, precedence rules, bounds, defaults, sibling outcomes, extension hooks, and data reshaping alter what happens;
3. crossings and effects — which runtime mechanisms carry the work, which state or external resources are observed or changed, and in what order;
4. observation — which return value, emitted event, notification, durable record, or downstream consumer makes the result visible;
5. failure and recovery — which retry, rejection, rollback, cleanup, interruption rule, later repair, or post-loop maintenance follows an incomplete or completed path.

These are possible fact classes, not assumptions that every system contains all five. Mark an absent class `excluded` only when evidence shows it cannot alter the answer. For comparisons, keep separate rows for both paths and for each discriminator between them.

Read [references/information-model.md](references/information-model.md) only when the user asks for the capability inventory, a ledger row needs a specialized analysis beyond the ordinary relationship families, or provider support is uncertain. It maps the complete kinds of information scip-query can expose to the system claims they can and cannot establish. Do not load it for routine end-to-end exploration.

When collaboration tools are available and authorized, and the main agent will continue from the investigation into planning, editing, or review, prefer a fresh delegated explorer for a multi-symbol causal spine. Read [references/delegated-exploration.md](references/delegated-exploration.md) before the main context performs repository exploration. The explorer owns read-only acquisition; the main agent receives only a claim-complete ledger, retains all mutation and user-facing authority, and revalidates affected claims after edits. Do not delegate a single exact lookup whose result is already local.

When `SCIP_EXPLORE_EVIDENCE_DIR` and `SCIP_EXPLORE_LEDGER` are set, read [references/external-evidence.md](references/external-evidence.md) before querying. That runner has requested external evidence mode: complete packets stay outside model context, bounded receipts support the investigation, and a claim-complete ledger becomes the only input to a fresh synthesis phase.

## Establish the causal spine

Start from the most discriminating exact referent already present in the request. Locate one only when needed. Reuse returned symbols and `file:line` identities as graph roots; do not rediscover the same unit through synonyms.

Treat all exact text already visible in a locator, inspect slice, or code receipt as located. Do not search for a function, call expression, constant, or message that is already present in delivered source. Do not run `outline` after exact source has already exposed the relevant unit boundaries. If a root has produced two failed or non-settling locator/outline attempts, use the best exact `file:line` already known with one bounded `inspect` and reassess the claim; do not alternate among more locators. A claim is not unsupported or excludable while a delivered exact identity or recovery command can settle a material clause.

When a locator returns competing implementations, make authoritative scope the first ledger row. Before reading either implementation body, compare only the evidence that can identify which path answers the question: external entry surfaces, incoming execution, ownership, consumers, or runtime handoffs. A core type, newer package, first search result, or public export is not ingress. Treat one path as authoritative only when exact evidence connects it to the scope named by the question. If one bounded comparison plus its exact relevant recovery cannot do that, preserve every plausibly live implementation as a separate scope; an ambiguous general question requires each live scope to be explained to the requested depth or explicitly left unresolved. Do not silently choose one, and do not exclude another without evidence that it cannot answer the question.

For a lifecycle, distinguish scheduling from execution and completion from later maintenance. If work is queued, establish both the event that creates the pending work and the later owner that observes and processes it, including their ordering. If plugins or other extension points can inject, replace, or transform material input, treat those operations as behavior rather than incidental calls. Include later filtering, reconstruction, pruning, or cleanup when it changes what a future consumer observes.

Select relationships because they can settle named ledger rows. Include the initiating owner as a root or request incoming execution when an end-to-end account needs ingress. Batch independent roots and related families when their evidence belongs to the same open question. When the interface supports concurrent tool calls, issue independent observations in one wave while preserving one complete result and cursor chain per command. Never combine results through a shortening pipe or abandon a printed `Continue exactly:` cursor; transport completion is required before coverage can be evaluated. Do not request every family to see what appears. Use graph evidence for relationships between units and behavior/source evidence for predicates inside a selected unit; neither substitutes for the other.

After each packet:

- record its normalized request and every delivered exact source interval; before another query, reject an exact duplicate and subtract already covered ranges locally;
- update only the ledger rows that its evidence actually establishes;
- preserve evidence strength, coverage, exact bounds, defaults, branch predicates, separately handled fields, ownership scope, state identity, ordering, and cleanup effects;
- mark a row `established` only when the selected behavior supports every clause in that row; an accurate high-level sentence does not settle omitted guards, markers, fields, stop conditions, or sibling outcomes;
- treat the exact formula of any configurable threshold, budget, or bound that changes selection as material; treat a durable reduction marker as unresolved until its later consumer and exact model-facing substitution are established or the provider reports that frontier unsupported;
- name the remaining gap before another query;
- follow a printed fold, recovery command, or adjacent identity only when it can close that gap;
- use `inspect --view behavior` for a named behavioral gap and `code` only when exact syntax can change the conclusion.

If two consecutive packets neither establish a row nor split one using a newly discovered behavior-changing fact, stop expanding that root and reassess the selected authority, relationship family, or ledger. Do not compensate for a weak root with more source.

At an input boundary, keep decoding or parsing separate from validation even when source nests them in one expression. Establish both failure paths before assigning a response: a validator that returns a failure result does not catch an exception or rejected promise raised while its argument is being produced. Preserve which enclosing handler catches that earlier failure.

Calls and exact runtime handoffs establish executable reachability within their stated coverage. Dataflow, state, temporal, contract, identity, ownership, reference, and dependency evidence establish only the relationship they name. A candidate is a lead requiring confirmation. A bounded or unsupported result cannot establish absence. If scip-query reports a specific unsupported frontier, use a native read only for that frontier and record why the exception was necessary.

## Synthesize the system

Condense observations into one causal account: when the initiating condition holds, the identified owner evaluates the material decisions, transforms or transfers the identified data, changes the identified state in the established order, and exposes the established result; on the relevant failure path, the established recovery behavior follows.

This causal account is not a chronology of files read. Organize it by what makes the behavior occur. Keep structurally different operations separate: a returned default is not a thrown rejection; a cache invalidation is not a generic state update; an enqueue is not successful consumption; local source order is not cross-process completion.

Before answering or editing, audit the draft against the ledger and every selected statement-complete behavior packet. Repair answer-side omissions from evidence already delivered instead of querying again. Preserve every material predicate, hard bound, default, separately merged field, durable effect, externally visible ordering, and cleanup action. If an unsupported row limits the conclusion, state that limit in the answer.

Stop when every material row is `established`, `unsupported`, or `excluded`, no contradiction remains among the rows, and no exact in-scope recovery command could change the answer. Packet completion, a plausible narrative, elapsed time, query count, and token cost are not stopping conditions.
