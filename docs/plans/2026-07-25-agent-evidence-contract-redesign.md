# Agent Evidence Contract — output integrity, permissive source policy, and a planning split

Date: 2026-07-25
Revision: 2 (incorporates review; see Revision notes at the end)

## Goal

A corpus study of Codex and Claude Code usage found three defects in how scip-query reaches
coding agents. Two are measured, one is self-inflicted:

1. **Blind truncation.** Claude used truncating selectors on 1,877 of 3,076 scip-query calls.
   Clipping was likely on 14/17 single `system` calls and 108/324 single `diff-gate` calls;
   only 158/459 gate runs preserved a recoverable internal outcome. Nothing in the output tells
   an agent whether it saw the whole result, so the loss is unfalsifiable from inside the turn.
2. **Invocation, not compliance.** Claude used 36/93 commands (Codex: 83/93). Only 204 of its
   3,076 calls were attributed to a current `scip-*` skill; 1,982 had no skill attribution and
   701 went to a project-local `concrete-plan` in another repo. Skill _bodies_ load after
   invocation, so body length cannot explain this.
3. **A prohibition we wrote ourselves.** `skills/_shared/SKILL.md:247` instructs subagents:
   _"Do not use grep, rg, cat, or file reads as evidence for code behavior."_ It is
   unenforceable, and its practical effect is to make agents launder ordinary file reads
   through the tool to satisfy a citation rule.

Done looks like: every public command declares what it returns and how much of the available
answer it examined; bounded results disclose at runtime what was actually capped, so an agent can
tell what it missed; anti-truncation guidance is enforced only where a narrower alternative
exists; ordinary planning no longer requires the high-assurance certificate; and native reads are
legitimate evidence for literal source content.

This plan is deliberately written at **ordinary planning weight** — end-to-end flow, affected
consumers, reuse, ordered slices, validation, explicit unknowns. It does not use the numbered-
premise / attack-record / verdict format of `2026-07-24-architecture-boundary-resolution.md`,
because the split proposed in slice B2 is exactly the argument that such a format should be
reserved for security boundaries, migrations, concurrency, and irreversible rollouts. Applying
the certificate here would contradict the plan's own thesis.

## Definitions

**Blind truncation** — an output transformation that discards records without first knowing
whether the result exceeded the retained range, and without preserving omitted counts or
identities. The distinguishing trait is epistemic, not quantitative: `head -50` on a 30-row
result loses nothing but is still blind, because the agent cannot distinguish that case from
`head -50` on 200 rows. This is why the success metric is _zero blind truncation_ and not
_zero proven information loss_ — the latter is unmeasurable from traces.

**Evidence tier vs coverage policy** — two independent properties that the first draft of this
plan conflated. _Evidence_ (`graph-fact | heuristic | mixed`, already descriptor-owned) describes
how a result was **derived**. _Coverage_ (`complete | bounded | sampled | unknown`) describes how
much of the available answer was **examined**. A heuristic scan can be complete; a graph-fact
query can be bounded. `heuristic` is therefore not a coverage value, and the existing `evidence`
field stays exactly as it is.

**Declared policy vs actual coverage** — the descriptor declares a command's _default_ policy.
What actually happened on a given invocation depends on `--full`, index size, analysis budgets,
and per-command limits, so it must be reported at runtime by the handler rather than inferred
from the descriptor. The envelope reports the actual; the descriptor sets the expectation.

**AgentContract** — the descriptor-owned declaration of a command's answerable questions,
returned units, positional input kinds, default coverage policy, and confusable neighbours.

**Evidence obligation** — a fact that must be established before a decision is safe. What
separates it from a command step: several commands may satisfy one obligation, and completion is
judged by the fact obtained rather than the command run.

**Retention stage** — one of three independently scored states for a required identity:
_Observed_ (reached the model's context), _Cited_ (used in the explanation or plan), _Acted on_
(the implementation or validation accounted for it). Scored separately because their measurement
costs differ by an order of magnitude.

**Tool-relative coverage vs external correctness** — two distinct oracles. Tool-relative coverage
compares a transcript against the complete scip-query result and measures whether the agent
retained the tool's evidence; it cannot prove the tool was right. External correctness compares
against independently built ground truth (seeded fixtures, language-server results, executable
tests, hand review). Never reported as one number.

## Current state (verified against the tree)

| Fact                                                                                                                                                                                                                                                     | Anchor                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| One shared JSON envelope for every `--json` command; already injects `command` and descriptor-owned `evidence`                                                                                                                                           | `src/runtime/command-kit/command-execution.ts` → `printJsonEnvelope`           |
| The envelope receives an arbitrary `result` — it cannot count records or extract identities generically                                                                                                                                                  | same function                                                                  |
| Envelope is pretty-printed at `JSON.stringify(…, null, 2)`                                                                                                                                                                                               | same function                                                                  |
| `CommandDescriptor` carries `evidence`, `heuristic`, `budget`, `renderShape`, `docs` — nothing about returned units or coverage                                                                                                                          | `src/runtime/command-kit/command-descriptor-types.ts`                          |
| 93 public commands; only 26 descriptors live in `command-descriptors.ts` — the rest are in `src/runtime/query-commands/*.ts` (navigation 15, graph 9, impact 5, direct-navigation 3, tla 2, health 2, planning 1, core 1) plus `query-commands/cleanup/` | `src/runtime/commands/command-descriptors.ts`, `src/runtime/query-commands/**` |
| A contract test already asserts descriptor↔CLI completeness — the natural home for a contract gate                                                                                                                                                       | `tests/runtime/cli-contract.test.ts:72`                                        |
| `refs` accepts only `--full` and `--json` — there is no `--limit`                                                                                                                                                                                        | `scip-query refs --help`                                                       |
| Skill command tables are generated by joining frontmatter `commands:` templates to `descriptor.description`                                                                                                                                              | `scripts/render-command-reference.ts` → `renderSkillCommandsMarkdown`          |
| The native-read ban, and its reviewer-side twin                                                                                                                                                                                                          | `skills/_shared/SKILL.md:247`, `:250`                                          |
| Generated AGENTS.md block: 7 bullets, incl. the edit→postcheck mapping and a blanket plan-first rule                                                                                                                                                     | `src/runtime/agent-setup.ts:125-131`                                           |
| Installed skill symlinks point at the **published package**, not this checkout: `~/.claude/skills/* → /opt/homebrew/lib/node_modules/scip-query/skills/*`                                                                                                | verified on this machine                                                       |
| `scip-concrete-plan` is 2,881 words; `_shared` is 2,555; router is 1,275; 32,732 total across 27 skills                                                                                                                                                  | `skills/*/SKILL.md`                                                            |

### Two consequences that reshape scheduling

**Every B-lane change has a release dependency.** Skill bodies reach agents through the installed
package. Editing `skills/*.md` in this checkout changes nothing for any running agent until a
version is published and picked up. B1 is two lines of text, but it is not "shipped" on merge.
The B lane should therefore batch into a single release rather than trickle, and the plan's
execution order below reflects that.

**The competing planner was not a shadowing collision.** `BUILTIN_SKILLS` ships
`scip-concrete-plan`; the other repo's skill is named `concrete-plan`. They never collided, and
`installSkills`' non-symlink skip is irrelevant to this case. The two competed purely on
description matching — and the differently-named local skill won 701 to 204. That makes B4 more
valuable than first scoped: it is direct evidence about trigger quality, which is exactly the
parked B5 problem, not archaeology about precedence.

## Workstreams

The only genuinely ordered dependency is A1 → A2 → A3. Everything else runs in parallel.

```
Output integrity                          Skills and instructions
────────────────                          ───────────────────────
A1. AgentContract schema + allowlist      B1. Lift the native-read ban (2 lines)
    gate + 5 exemplar contracts
          │                               B2. Split ordinary / high-assurance planning
          ├── A2. Runtime coverage         	  (certificate → HIGH_ASSURANCE.md)
          │       disclosure + agent
          │       result + pagination      B3. Relocate the edit→postcheck mapping
          │
          └── A3. Anti-truncation          B4. Time-boxed old-planner comparison
                  enforcement, scoped to
                  commands A2 paginated    B5. (parked) description/trigger tuning
                                               — now fed directly by B4
A4. Backfill remaining 88 contracts
    against the shrinking allowlist
```

---

## Slice A1 — AgentContract schema, allowlist gate, five exemplars

**Change.** Add to `CommandDescriptor`:

```ts
export type CoveragePolicy = 'complete' | 'bounded' | 'sampled' | 'unknown';

export type CommandInputKind = 'symbol' | 'file' | 'module' | 'pattern' | 'path' | 'action' | 'diff' | 'repository';

export interface CommandAgentContract {
  answers: readonly string[]; // task questions this command settles
  returns: readonly string[]; // concrete units in the result
  inputs: readonly CommandInputKind[]; // positional kinds, in order; [] = no target
  coverage: CoveragePolicy; // DEFAULT policy; actual is reported at runtime
  contrasts?: readonly { command: string; distinction: string }[];
}
```

`inputs` is a list rather than a single `target` because the command set does not fit one union:
`similar <a> <b>` is `['symbol','symbol']`, `coupling <f1> <f2>` is `['file','file']`,
`tla <operation> [spec]` is `['action','path']`, `files <pattern>` is `['pattern']`, and
`hotspots`/`cycles`/`stats` are `[]`.

`coverage` is the load-bearing field and is explicitly a _default_: `complete` means the default
result is the whole answer; `bounded` means a cap may engage; `sampled` means the command
deliberately examines a subset; `unknown` means the command cannot currently determine it — which
is an honest value, not a placeholder, and A2 is what reduces its population.

Author contracts for the five commands that drive the corpus failures — `diff-gate`, `system`,
`plan-context`, `trace`, `refs` — and prove the shape against real output before writing 88 more.

**The gate ships green, via a shrinking allowlist.** A deliberately-failing test cannot merge,
which would serialise A1 behind A4 and destroy the parallelism this plan depends on. Instead:

```ts
const COMMANDS_AWAITING_AGENT_CONTRACT = new Set([
  /* the remaining 88 */
]);
```

The test asserts that every non-hidden descriptor either has a valid contract or is named in the
allowlist, **and** that the allowlist contains no unknown command ids. CI is green throughout;
a new contract-less command fails unless someone adds it to the allowlist deliberately, which is
a visible act in review. Each A4 batch deletes names until the set is empty, at which point the
allowlist itself is removed.

**Validation.** Full `cli-contract` suite green. The failure message for a missing contract names
the command and prints the remaining allowlist count, so the backfill has a countdown.

**Reuse note.** No new registry. `commandEvidenceById` in `command-execution.ts` already shows the
pattern for a descriptor-derived lookup consumed by the envelope; the contract lookup follows it.

## Slice A2 — runtime coverage disclosure, agent result, pagination

Depends on A1, because "what was omitted" cannot be expressed until each command declares what a
complete answer would have been.

**Change 1 — coverage is reported by handlers, not computed by the envelope.**
`printJsonEnvelope` receives an arbitrary `result`; it has no way to count records, extract stable
identities, know whether omitted records were ever materialized, or build a continuation cursor.
Handlers supply it:

```ts
export interface InvocationCoverage {
  complete: boolean | null; // null = the command cannot determine it
  totalKnown: boolean;
  returned: number;
  total?: number;
  omitted?: number;
  omittedIdentities?: readonly string[];
  continuation?: { cursor: string; indexGeneration: string };
}
```

The first draft of this plan committed to "always keep every stable identity when capped." That
is not universally payable: several bounded queries stop scanning early, and materializing the
omitted identity set would force exactly the full computation the bound exists to avoid.
`omittedIdentities` is therefore required **only when the full identity set was already
materialized**, and `totalKnown: false` is the honest signal otherwise. Validation asserts
`omittedIdentities.length === omitted` only when the field is present.

`continuation.indexGeneration` is included because a cursor is meaningless across a reindex; the
DB generation is already tracked and surfaced by `status`.

**Change 2 — a small complete agent result for heavy commands.** This, not whitespace, is the
integrity fix. For `diff-gate`, `system`, and `plan-context`, emit a compact result that is
complete on its own terms: summary and internal outcome; total counts; every blocking finding id
for `diff-gate`; the coverage disclosure; and an artifact path or continuation cursor for the
heavy detail. An agent that reads only this object has a correct, non-partial answer and knows
where the rest lives.

**Change 3 — `--compact` as a cheap optimization, correctly framed.** Dropping
`JSON.stringify(…, null, 2)` to zero indentation reduces characters with no information loss, but
it is _not_ the integrity fix and a clipped minified document is no more parseable than a clipped
pretty one. It is still worth doing for one specific reason: the failure mode the corpus actually
measured is _line-based_ selection (`head`, `tail`, `sed`), and a minified document is one line,
so `head -50` returns all of it. It attacks the observed behaviour, not a hypothetical one. Ship
it as an optimization, documented as such.

**Change 4 — pagination where A3 will need it.** `refs` has no `--limit` today. A3 cannot tell an
agent to "narrow the command instead" for a command that offers no narrowing. A2 must add a
bounded selection option (with the cursor above) to at least the commands A3 will police, and
that per-command coverage — not a single hook — is what bounds A3's scope.

**Validation.** Per-command tests: a forced cap yields `complete: false`, `returned < total` when
`totalKnown`, `omitted` equal to the difference, and identity-count equality only where
`omittedIdentities` is emitted. Envelope changes are additive-only: existing keys (`command`,
`evidence`, `analysisBudget`, `args`, `options`, `result`) keep position and semantics, since
`diff-gate --json` consumers and this repo's own tests read them. Acceptance is that no existing
test rewrites an expectation — only extends one.

## Slice A3 — anti-truncation enforcement

Depends on A2, and its scope is bounded by A2 command-by-command: enforcement may only police
commands that have a narrowing alternative. Rolling it out per paginated command is the plan;
a single global hook is not.

**Enforcement is asymmetric, by construction.** Claude Code can reject a blind selector before
execution via a `PreToolUse` hook matching piped `head`/`tail`/`sed` on a `scip-query` command.
Codex's current integration can supply instructions, compact output, and telemetry, but not
pre-execution rejection. That asymmetry is compatible with one shared behavioural policy — it is
the one place platform-specific code is warranted.

Consistent with the standing decision in `src/runtime/agent-setup.ts` (the module deliberately
writes no tool's hook config, because three independent schemas that silently drift are worse
than one documented line), this slice ships the hook _script_ and documents the config line. It
does not write `.claude/settings.json`.

**Validation.** For each covered command, the hook rejects the piped-selector form and permits the
command's own bounded form. Metric: blind-truncation rate on Claude transcripts, target zero,
reported as a Claude-scoped number with Codex reported separately as instructions-and-telemetry.

## Slice A4 — backfill the remaining 88 contracts

Runs in parallel with A2/A3 against the shrinking allowlist. Bounded category passes so the work
is reviewable: navigation; graph and impact; cleanup detectors; health and verification; setup and
maintenance; framework and formal-model.

**Most of this work is not in `command-descriptors.ts`.** Only 26 descriptors live there; the rest
are defined across `src/runtime/query-commands/*.ts` and `query-commands/cleanup/`. Category
passes should follow those module boundaries rather than the CLI's alphabetical order.

**This is an audit, not a metadata chore.** Declaring coverage per command forces a question the
descriptors have never been asked, and the expected findings concentrate in two places:
deprecated aliases (`convergence` → `similar --plan`, `capability-matrix` → `capabilities
--matrix`), and similarity commands whose current `graph-fact` tier can overstate certainty
relative to what they compute. Tier corrections belong in this pass.

**Acceptance.** 93/93 non-hidden commands carry a contract; the allowlist is deleted; the
generated skill tables in `renderSkillCommandsMarkdown` gain `Returns` and `Coverage` columns
sourced from the contract rather than from prose.

---

## Slice B1 — lift the native-read ban

Independent of everything, including the `code` experiment. Two lines in
`skills/_shared/SKILL.md`.

Replace the subagent rule at `:247`:

> Use scip-query for compiler-resolved identity and for completeness claims. Native search and
> file reads are valid evidence for literal source content and local logic, including an
> unambiguous helper you can see in the same file. Use scip-query when you assert **which symbol
> something resolves to** or that a set is **complete** — definitions, references, callers,
> dependencies, consumers, or affected units. Cite the evidence source appropriate to each claim,
> and say so when neither source establishes it completely.

The trigger is _resolution or completeness_, not crossing a call boundary. An earlier draft of
this rule drew the line at the function body, which forbids reading a same-file helper that is
right there and unambiguous — overcorrecting in the same direction as the ban it replaces. The
failure mode worth preventing is asserting what `handler(x)` does without resolving `handler`,
and that is a resolution claim, so the narrower trigger already covers it.

Update the reviewer-side twin at `:250` in the same edit. As written — _"Reject subagent findings
that cite text search or raw file reads as code evidence when graph facts were required"_ — the
qualifier keeps it technically correct, but left alone it re-imposes the ban from the review side.
It should reject only resolution and completeness claims sourced from text search.

**Explicitly not in scope:** steering agents _away_ from `code`. Separate, unproven (see
Unscheduled).

## Slice B2 — split ordinary and high-assurance planning

`skills/scip-concrete-plan/SKILL.md` currently requires formal definitions, numbered premises,
state-authority inventories, testability matrices, adversarial attacks, deployability
declarations, enforcement windows, coverage matrices, and a derived verdict — for every
non-trivial edit, per the router's default loop and `agent-setup.ts:127`.

**Ordinary mode** (~500–700 words, stays in `SKILL.md`) produces: goal and scope; current
end-to-end flow with evidence; affected consumers and public-contract impact; a reuse decision per
proposed new unit; ordered implementation slices with files, symbols, behaviour, and validation;
risks, unknowns, rollout constraints. Complete when the entry-to-effect path is understood, every
affected consumer is assigned to a slice, every new abstraction has a reuse decision, every slice
has validation, and unknowns are stated.

**High-assurance mode moves to a separate `HIGH_ASSURANCE.md`** in the same skill directory,
loaded on demand. Keeping the certificate material inside `SKILL.md` would leave all 2,881 words
loading on every invocation, which is the entire defect. It loads for: security boundaries,
authorization, money, destructive operations, persistent-data migration, shared-state concurrency,
broad public API change, irreversible rollout, or explicit user request.

The router's default loop and the AGENTS.md bullet both change: an implementation request needs a
scope check to pick the mode, not an unconditional certificate.

`plan-context` already returns definitions, references, callers, callees, dataflow, forward and
backward slices, affected symbols, change-surface risk, dependencies, module exports, external
surface use, complexity, churn, co-change partners, and suppressions. Ordinary mode's job is to
_interpret_ that composite, not rebuild a second proof system on top of it.

## Slice B3 — relocate the edit→postcheck mapping

`agent-setup.ts:128` carries the one genuinely repo-specific thing in the generated block:
extracted helper → `incomplete-migration`; new helper → `recent-duplicates`; new params →
`unused-params`; new wrapper → `wrapper-candidates`; schema/config change → `co-change`; deleted
code → `cleanup-plan --verify`.

The short instruction block replaces it with "run only the postchecks relevant to the edit," which
presumes the agent knows the mapping. Move the table into `skills/scip-verify/SKILL.md` rather
than deleting it. The generated block shrinks to the decision boundary plus a pointer.

## Slice B4 — time-boxed old-planner comparison

Bounded to: read the other repo's `concrete-plan` body, diff its frontmatter description against
`scip-concrete-plan`'s trigger surface, and check whether its 701 attributed calls came from many
invocations or a few large batches. 701 is a _command-call_ count, not an invocation count.

Because the two skills have different names and never collided at install time (see Current
State), this is a clean comparison of trigger quality between two co-present skills — which makes
it the primary input to B5 rather than a side investigation. It still gates nothing.

Ships alongside: documentation that removing a competing project-local skill is a manual per-repo
act.

---

## Measurement

Split by what can actually be scored, and never combined into one number.

**Mechanical, full N:**

- Blind-truncation rate (Claude-scoped for enforcement; both agents for telemetry). Target zero,
  per covered command, once that command has a narrowing alternative.
- Recoverable `diff-gate` outcomes. Target ≥95%, from a 158/459 baseline.
- **Unexplained-repeat rate**: repeats with no recorded mutation and no new user prompt. Codex
  `code` baseline is 1,592 of 41,198 (~3.9%).
- **Successful-repeat rate**: repeats that followed a _recoverable prior success_ — only 62 of the
  1,592 qualify, because most earlier exit outcomes are unknown. This needs its own denominator
  (recoverable-outcome calls, not all calls) and must not be quoted as ~3.9%. The first draft of
  this plan made exactly that error.
- Output characters and retained identities per command.

**Mechanical for stages 1–2, hand-reviewed for stage 3:** retention against a precomputed required
set (consumers, callers, writers, affected symbols). _Observed_ and _Cited_ are extractable from
transcripts at full N. _Acted on_ requires judging whether an implementation accounted for a
symbol; scoring that with a model at scale would build exactly the check-that-never-fails this
repo ships a detector for. Score it on a small hand-reviewed subset and report it as such.

**Diagnostics, not success criteria:** command breadth (gameable) and findings-per-changed-line
(more findings can mean better detection or worse code).

Command-selection accuracy is scored only on tasks labelled eligible for that command family, and
Codex/Claude are compared only on identical repository states and prompts.

## Deliberately unscheduled

- **B5 — skill description and trigger tuning.** The invocation defect (36/93 commands, 204/3,076
  skill-attributed calls) has no acting slice here. B4 reports first. It is named so it does not
  quietly fall off the board — it is the defect that started this investigation.
- **Skill consolidation (27 → 10–14).** Deferred for the same reason. Merge only where trigger
  surfaces demonstrably overlap (cleanup-audit/improve; react/vue/directory maintainability).
  Sharp specialists — `scip-probe-reachability`, `scip-twin-drift` — should not be folded into
  fuzzier parents without evidence of routing confusion; a broader trigger is not a better one.
- **`code` vs native range reads.** Usage is lopsided (Codex 41,198 / Claude 713) but nothing in
  the corpus shows `code` is _worse_ than a native read; its compiler-resolved identity and
  definition-bounded output may be both cheaper and safer. The repeat evidence is weaker than
  first stated (62 confirmed successful repeats, not 1,592). Needs a matched-task experiment
  measuring tokens, latency, and correctness, particularly on ambiguous same-named symbols where
  a native read has no disambiguation story. Different question from B1: permitting native reads
  ships now; steering away from `code` waits for evidence.

## Files

| File                                                           | Slice                                     |
| -------------------------------------------------------------- | ----------------------------------------- |
| `src/runtime/command-kit/command-descriptor-types.ts`          | A1, A2                                    |
| `src/runtime/commands/command-descriptors.ts`                  | A1, A4                                    |
| `src/runtime/query-commands/**`                                | A4 (the bulk of the 88)                   |
| `src/runtime/command-kit/command-execution.ts`                 | A2                                        |
| `tests/runtime/cli-contract.test.ts`                           | A1 (allowlist gate), A4 (allowlist empty) |
| `scripts/render-command-reference.ts`                          | A4                                        |
| `src/runtime/agent-hooks.ts` + hook script                     | A3                                        |
| `src/runtime/agent-setup.ts`                                   | B2, B3                                    |
| `skills/_shared/SKILL.md`                                      | B1                                        |
| `skills/scip-concrete-plan/SKILL.md` + new `HIGH_ASSURANCE.md` | B2                                        |
| `skills/scip-verify/SKILL.md`                                  | B3                                        |
| `skills/scip-query/SKILL.md`                                   | B2                                        |

## Execution order

A1 and the B lane start together. A2 follows A1; A3 follows A2 and rolls out per paginated
command; A4 runs against the allowlist throughout. B4 runs on its own time box and gates nothing.

**Release note:** B1, B2, and B3 change skill bodies, which reach agents only through the
published package (installed symlinks point at `/opt/homebrew/lib/node_modules/scip-query/skills`,
not a checkout). Batch them into one release rather than shipping each on merge, and treat the
publish — not the merge — as the point where agent behaviour can change.

## Revision notes

Revision 2 corrected six substantive errors in revision 1, four of which were verified against the
tree rather than accepted on argument:

1. `heuristic` was wrongly used as a coverage class; evidence tier and coverage are independent.
2. The CI gate was specified as deliberately red, which cannot merge and would have serialised
   A1 behind A4; replaced with a shrinking allowlist.
3. The envelope was assumed able to compute completeness from an arbitrary `result`; coverage is
   now handler-reported, and the "always keep every omitted identity" commitment was dropped as
   unpayable for early-stopping queries.
4. Minified JSON was presented alongside the integrity fix; it is an optimization, and the
   structural fix is a small complete agent result.
5. The `refs --limit 50` example did not exist (verified); this exposed a missed dependency —
   A3's scope is bounded by A2's per-command pagination.
6. The repeat baseline conflated unexplained repeats (1,592) with confirmed successful repeats
   (62), which need different denominators.

Also corrected: the B1 boundary (resolution/completeness, not call-boundary); B2 needs a separate
`HIGH_ASSURANCE.md` or the words still load; A4's file inventory (most descriptors are under
`src/runtime/query-commands/**`, verified); the "shadowing" framing (the competing planner is a
differently-named skill that never collided, verified — which upgrades B4 into B5's input); and
the release dependency (installed symlinks point at the published package, verified — so no B-lane
change reaches an agent on merge).
