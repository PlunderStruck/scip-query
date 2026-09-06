# Agent workflows and module evidence

scip-query is built for coding agents. Its workflows address choosing the wrong implementation, copying an existing rule, overlooking consumers, leaking coordination into callers, and mistaking an incomplete implementation for finished behavior.

## Six skills

Setup and `install-skills` install all six workflows into available Claude, Codex, and shared agent roots. `--all` remains compatible with existing scripts and has the same result. Agents load only the workflow relevant to their task.

| Skill | Responsibility |
| --- | --- |
| [scip-query](../skills/scip-query/SKILL.md) | Shared commands, evidence limits, transport, and actual-diff review |
| [scip-explore](../skills/scip-explore/SKILL.md) | Establish live behavior, relevant owners, consumers, decisions, effects, and recovery |
| [scip-plan](../skills/scip-plan/SKILL.md) | Concrete implementation order, preserved behavior, consumer migration, retirement, and checks |
| [scip-architecture-review](../skills/scip-architecture-review/SKILL.md) | Evaluate architecture and maintainability using concrete consequences for future changes |
| [scip-integrity-audit](../skills/scip-integrity-audit/SKILL.md) | Compare promised behavior with live behavior; exercise distinguishing positive/negative cases |
| [scip-setup](../skills/scip-setup/SKILL.md) | Diagnose and repair indexing, freshness, watchers, caches, and installation |

Architecture review absorbs principal-maintainability-review, scip-system-compression, and structural investigations from scip-root-cause and scip-twin-drift. Integrity review absorbs scip-claim-audit, scip-probe-reachability, scip-calibrate, and behavioral comparison of competing implementations. Planning absorbs the useful execution/retirement guidance from conductor. The concrete-plan alias is removed.

Upgrade removes links into this package for retired skills. It preserves unrelated links and user-owned files. Existing prompts naming retired workflows must use the canonical names above. Historical audit documents retain their original skill names as records of those runs.

All six skills link the relevant sections of the [shared command decision guide](../skills/scip-query/references/command-guide.md). Every public command has a question, selector/mode, index prerequisite and interpretation limit. The guide separates internal transport/workers and explains which overlapping-looking controls answer different questions. Agents load the needed section, not an all-command checklist.

## One module evidence view

```sh
scip-query system --source
scip-query system --source src/payments
# Or use an exact group ID printed by the inventory:
scip-query system --source 'directory:src/payments' --full
```

Source mode reads the current TS/JS snapshot and configuration without creating a compiler index. It uses the same source analysis as health, but includes modules with no findings. Unambiguous configured boundaries take precedence; remaining files are grouped by directory. A path selects whole groups containing matching files, not a guessed business subsystem.

Each group exposes files, grammar-derived export declarations, imports, incoming import sites, production dependency/consumer files, and finding identities. Cross-group edges retain exact import sites and distinguish value/type, production/test, and static/dynamic/CommonJS syntax. Findings retain derived/candidate labels. The report also exposes configured boundary coverage and unknown dependency-policy rows.

In machine output, `imports` stores each parsed import observation once. Group `importIds`, `incomingImportIds`, and edge `importIds` are indexes into that report's table; they are not identities to reuse across runs. Human output resolves these references to source locations.

Export declarations are starting locations for interface investigation. Wildcard exports are not expanded; CommonJS export assignments, class member interfaces, external consumers, runtime registrations, and complete symbol invocation coverage are not established. `system <path>` retains the indexed summary; indexed `surface <path>` and selected `evidence` relationships supply additional facts where supported. A syntax tree, a resolved reference, and observed execution establish different things.

The human view limits displayed groups and examples and prints exact recovery. `--full` shows all captured rows; it does not remove scan bounds. `--max-files` raises the default 10,000-file limit. File and snapshot byte bounds, parsing/configuration failures, missing imports, and exclusions remain disclosed. Use `--include-tests`, `--include-references`, or `--include-generated` for optional source roles. Save exhaustive machine output using `--json --json-output <path>`.

## Design and integrity judgments

The tool reports structure and checks declared rules. The architecture skill requires the agent to connect a concern to a real maintenance mistake, examine consumers and counterevidence, and explain how a proposed change reduces required knowledge or coordination. Deep interfaces are evaluated by caller obligations; no depth or architecture score is produced.

Integrity review starts with a specific promised outcome, traces the live route, and exercises cases that distinguish a real implementation from a shortcut. A parser library being present does not prove it replaced regex extraction. A missed parser probe does not prove a branch unreachable. Literal status values can be justified by preceding checks; computed status can still be misleading.

Skills are agent instructions. They do not enforce their own compliance or establish better agent behavior merely by existing. Workflow effectiveness requires comparing actual agent tasks and resulting changes, alongside deterministic tests for the tool's reported facts. Inventory coverage and behavioral-review coverage must be reported separately.
