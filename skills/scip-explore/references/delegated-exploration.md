# Delegated live exploration

A delegated explorer is a read-only subagent that turns one fixed repository question into a claim-complete evidence ledger for a separate coding agent. Its defining boundary is that it may observe and record the system but cannot change the repository, choose the implementation, grade its own work, or answer the user. The separation keeps acquisition transcripts outside the main coding context while leaving decisions and effects with the agent responsible for them.

Use this mode only when the active environment permits subagents and the investigation spans enough owners, branches, crossings, or effects that direct exploration would materially enlarge the main context. The main agent remains responsible for the user's objective, permissions, edits, checks, commits, and final answer.

## Create the checkpoint

Before spawning, the main agent:

1. states the exact question and initial material claims without exploring their answers;
2. creates one private temporary root outside the repository, containing an evidence directory and ledger path;
3. records the current repository root, commit, dirty paths, and intended scope;
4. refrains from tracked-source edits until acquisition returns.

Start one fresh explorer with no inherited conversation turns. When the collaboration surface supports explicit profiles, request `gpt-5.6-terra` with `xhigh` reasoning for a terminal ledger unless the user selected another profile or broader fixed evaluation has established a better one. Do not silently substitute a different model or reasoning level.

Treat `gpt-5.6-sol` with `low` reasoning as an experimental balanced profile, not yet the default. On one frozen OpenCode external-ledger run it recovered 6/7 strict compound facts in 338 seconds for about 43.10 Codex credits, versus Terra-xhigh's 5/7 in 630 seconds for 33.20 credits. It has not been repeated across seeds or task shapes. Use it when the user accepts the measured credit premium for faster turnaround and stronger observed clause retention; disclose that the evidence is one run.

Use `gpt-5.6-sol` with `medium` reasoning as an accuracy escalation when a decision-critical compound claim remains unresolved after Terra, or when the user explicitly prioritizes accuracy over credits. On one frozen OpenCode external-ledger run it recovered 7/7 strict compound facts versus Terra-xhigh's 5/7, but cost about 2.5 times as many Codex credits, used 60 semantic queries instead of 23, and has not been repeated across task shapes or seeds. Give Sol the unresolved claim ids and accepted ledger for an audit or targeted delta; do not repeat a complete acquisition unless the earlier ledger is unusable.

Treat `gpt-5.6-luna` with `max` reasoning as an experimental economy pre-pass, not as a terminal-ledger replacement. Use it only when the user explicitly prioritizes cost or the result is a preliminary map. Before relying on its ledger for an implementation or compound system claim, give the question and ledger—not its receipts or transcript—to a fresh Terra-xhigh auditor; turn every missing or weakened material clause into a targeted Terra delta. Do not claim that this hybrid saves cost until its complete acquisition, audit, and delta path has been measured.

Give the explorer only the question, material-claim seed, repository and temporary paths, observed baseline, and these instructions. Require it to load `$scip-explore` and `$scip-query`, read [external-evidence.md](external-evidence.md), and run each scip-query observation through the capture wrapper with the assigned evidence directory. The explorer may prepare or refresh scip-query's private index when required; it may not edit, stage, commit, run tests, mutate external systems, inspect an evaluation rubric, or broaden the user's scope.

The explorer writes either a complete base ledger or a blocked ledger. Its visible response is exactly `LEDGER_READY <absolute-ledger-path>` or `LEDGER_BLOCKED <absolute-ledger-path>`; it does not paste the ledger, receipts, raw packets, or a user-facing explanation into the subagent response.

## Accept the handoff

The main agent reads only the ledger. Accept `LEDGER_READY` only when:

- the path is the assigned path and the file is nonempty and bounded;
- the header names the exact task, scope, baseline, receipts, and observation identities;
- the scope manifest accounts for every plausibly live production scope from complete locator evidence; a named but unexplored live scope rejects the handoff unless exact routing evidence excludes it;
- the ledger state is `complete` and no material row remains `unresolved`;
- every established row has exact citations, evidence strength, and coverage;
- receipts combined within a claim describe compatible, adequately stable observations.

If the explorer returns `LEDGER_BLOCKED`, the signal is malformed, the snapshot changed, or a required identity is unknown, do not silently explore in the main context or downgrade the explorer. Retry a fresh explorer only when a named recoverable gap can be corrected; otherwise tell the user which evidence boundary prevented the handoff.

A Sol-low base ledger that fails the scope-manifest or clause-transfer check is not accepted because it is cheaper. Give only the missing scope or claim ids to the configured accuracy escalation as a targeted delta; do not repeat already accepted acquisition.

After acceptance, the main agent synthesizes the system and may read only the exact implementation surfaces needed to edit. It never reads raw packets merely to gain confidence. Keep the temporary evidence until the task's verification is complete, then remove only the exact temporary root created for this handoff.

## Revalidate after edits

An edit changes the repository snapshot and therefore ends the original ledger's authority over current state. Run `scip-query diff-impact` after a nontrivial change and identify which relied-on claim ids intersect changed or affected symbols and files.

A ledger delta is a new read-only handoff that binds an earlier ledger to a later repository snapshot while replacing only claims whose truth or evidence may have changed. Spawn a fresh explorer with the original question, base-ledger checksum, affected claim ids, diff-impact result, and new temporary paths. The delta explorer first ensures scip-query's index reflects the changed tracked sources; an unchanged index-generation identity after an indexed source change cannot authorize the new snapshot. The delta must name the new observation identities, invalidated or superseded ids, replacement terminal rows, and any unchanged rows whose continued applicability it establishes. Do not make the main agent carry the earlier exploration transcript into this pass.

The main agent may retain an old claim only when the delta establishes that the change cannot affect it. A moved commit, changed content or index identity, invalidated stability proof, incompatible receipt, or unknown relationship blocks reuse rather than producing a warning.
