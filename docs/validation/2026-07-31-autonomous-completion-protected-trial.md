# Autonomous completion protected-trial result

Date: 2026-07-31
Outcome: `insufficient`

## What was tested

A protected mission trial is an end-to-end comparison of autonomous repository
work whose fixture, goal, evaluator, agent configuration, budgets, and decision
rule are fixed before counted execution. Its concrete referents here are four
fresh control/workflow pairs changing the same archived JavaScript repository,
the hidden policy-routing evaluator outside every candidate, and eight
create-only run records. What distinguishes it from an ordinary test or
benchmark is that an independently controlled repository judgment and the
agent's total operating cost jointly determine the outcome.

The counted program is
`SQTP-2FB7335FEA79CDF6BA5FD67542C1B297`. Its protected program record has
SHA-256
`c74e6babe490147c5cc7cb712a20d8b51a5b0f7d946412ac16fcb8884f1c47af`.
The protected root used for this local run is:

```text
/Users/aydansalois/Documents/GitHub/scip-query-protected-trials/2026-07-31-autonomous-completion-v1
```

The supported scope is exactly:

- provider/model: `openai/gpt-5.6-sol`;
- runtime: `codex-cli@0.144.6`, medium reasoning, workspace-write sandbox;
- fixture: `policy-routing-overhaul`;
- agent parameters SHA-256:
  `f0a3fe59e3e8e5911f0b498eeb996c34d40b851627e0e02c83d0585d8c1d75b0`;
- maximum elapsed time: 900,000 ms;
- maximum reported model tokens: 2,000,000;
- maximum tool calls: 400; and
- four alternated matched pairs, with two apparatus-only reruns permitted per
  condition.

A preceding one-pair apparatus program,
`SQTP-148390725B7805A957E392B6D887DC46`, showed that the initial 250,000-token
assumption was not viable. Those two pilot outcomes remain immutable but do
not count toward the decision dataset. The counted runner records a candidate
that finishes above its model-token or tool-call ceiling as `interrupted`
rather than excluding an unfavorable resource outcome.

## Protected result

Every one of the eight candidate repositories satisfied the hidden goal,
invariants, affected-surface, residue, reintroduced-behavior, and architecture
checks. Mission completion additionally required `completed` status within the
registered resource envelope.

| Pair | Control | Workflow | Completion direction |
| --- | --- | --- | --- |
| 01 | interrupted; 593,560 ms; 3,187,255 tokens | completed; 355,203 ms; 1,778,806 tokens | workflow improved |
| 02 | interrupted; 522,303 ms; 2,435,529 tokens | interrupted; 564,317 ms; 3,960,551 tokens | tie |
| 03 | interrupted; 506,191 ms; 2,635,388 tokens | interrupted; 493,536 ms; 2,329,578 tokens | tie |
| 04 | completed; 401,411 ms; 1,426,196 tokens | interrupted; 480,322 ms; 2,758,020 tokens | workflow regressed |

The immutable report contains eight eligible selected outcomes, four matched
pairs, no record issue, and no architecture regression. Its registered
classifier reports:

- classification: `insufficient`;
- full completion: control 25%, workflow 25%, difference 0 percentage points;
- paired direction: one improved, one regressed, two tied;
- probability that treatment is better: 50%, with an 80% interval from
  approximately 16.4% through 83.6%;
- median elapsed workflow/control ratio: 1.028;
- median model-token workflow/control ratio: 1.255, beyond the allowed 1.2;
- median tool-call ratio: 0.713; and
- sufficiency issue: three treatment blocker-validity observations remain
  unknown.

`effectiveness` and `health` both render this program as `insufficient` under
`protected-matched-trials` authority. Health retains its independent 93/100
repository score; mission evidence does not rewrite it.

## Root-cause findings

The protected repository result and the controller result diverged in workflow
pairs 02–04. Each agent produced evaluator-clean code, but the Stop controller
blocked because the agent-created goal and the required `.scipquery.json`
change were absent from the fixed predecessor. The agents' final messages
correctly identified that candidate-controlled goal or configuration evidence
cannot authorize itself. The trial runner had no independent observation for
whether those blockers were valid, so it retained `blockerWasValid: null`; the
classifier correctly refused to manufacture a false-blocking judgment.

An authorization bridge is a protected intake channel that turns a principal's
external request into goal and transition authority before candidate work can
alter its own judging artifacts. It is a kind of evidence boundary, and what
distinguishes it is that the candidate may consume the authorization but cannot
create, weaken, or replace the authority that validates the same attempt. The
current skills materialize an unambiguous user request into repository goal
records, but the controller sees those new records only as candidate changes.
Weakening the reflexive-authority firewall would conceal the problem; the
missing unit is independent intake provenance.

Verification compression is a reduction of agent-visible evidence that keeps
every fact capable of changing the next rational action or completion
judgment. It is a kind of runtime optimization, distinguished from arbitrary
truncation by preserving decision-equivalent outcomes. The counted workflow
used fewer median tool calls and metadata commands than control, yet consumed
1.255 times the median model tokens. The transcripts show high variance and
occasionally very large SCIP output, so command selection, bounded coverage,
and restoration/closeout summaries need to become more decision-selective.

## Established and not established

The run establishes, for this exact fixture and runtime, that:

- all eight autonomous agents could produce the technically complete,
  residue-free, architecture-conformant repository without human input;
- the workflow did not introduce an architecture regression;
- the current protected controller can refuse technically correct work when
  its goal or configuration authority was not fixed independently; and
- the workflow's token efficiency does not meet the registered bound.

It does not establish that autonomous completion v1 improves full-completion
rate, avoids false blocking, or improves operating efficiency. It also does not
generalize beyond the named provider, model, runtime, parameters, and fixture.

The next counted program must not reuse these outcomes. It requires a new
content-identified program after an authorization bridge and verification
compression are implemented, followed by fresh matched candidates under a
new pre-registered parameters digest.
