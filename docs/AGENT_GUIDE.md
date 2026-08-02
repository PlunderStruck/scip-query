# Agent guide

scip-query supplies repository evidence. The agent owns the goal, plan, code,
tests, and final decision.

## Before a nonlocal edit

Run one aggregate mapping query:

```bash
scip-query context <target>
```

Treat its source packet as already read. Write a normal concise plan. Add a
focused query only when a named uncertainty can change that plan.

## After a coherent edit

Run the repository's native checks. Then map downstream consumers when the
change can propagate:

```bash
scip-query diff-impact
```

For declared structural rules, run:

```bash
scip-query architecture
```

For cleanup, drift, React, or Vue work, run the relevant health or focused
detector command. Confirm heuristic candidates in source before editing them.

```bash
scip-query health --full
scip-query react-hook-candidates --full
scip-query vue-composable-candidates --full
```

There is no scip-query acceptance ceremony. Native tests establish behavior;
scip-query adds relationship and cleanup evidence.

## Efficient use

- Use native search for literal text.
- Do not repeat an unchanged query after context compaction.
- Use `--full` only when complete coverage can change a decision.
- Follow an emitted `Continue exactly:` command until transport is complete.
- Use human output for model reading and `--json --result-only` for programs.
- Commit relevant suppression files, but do not create work-state records.

## Setup failures

Use `scip-query doctor` when a query reports that the tool or index is not
usable. Use `scip-query status --capabilities` to see which evidence providers
are available.
