# Command guidance for agent skills

The user authorized finishing the command-to-skill guide. Work on main; preserve the unrelated untracked LaunchPoint report. The prior command audit found 81 public commands and five internal controls. Only 62 public names were explicit across the six skills and their local references; an old reference still named the retired `isolated` command.

## Intended result

Every public command has a discoverable question, a concrete selector or mode, an index requirement, and a limit on its interpretation. Skills link the relevant parts of one shared reference. Agents select a command for a missing fact; the guide is not a checklist of commands to run. Internal transport and worker controls have a separate explanation.

## Work

- [x] Verify current registry, handlers and source/index mode exceptions.
- [x] Write `skills/scip-query/references/command-guide.md` with task-oriented sections and distinctions between overlapping controls.
- [x] Link sections from all six skills; consolidate the older information-model reference and remove its retired command.
- [x] Update active documentation and record commands that merit a later consolidation review without deleting capabilities from documentation alone.
- [x] Check all public registry identities against guide rows and validate skill links and existing CLI/skill contracts.

The guide does not establish command accuracy beyond each command's existing evidence and coverage contracts. A controlled cheaper-model task comparison remains a separate evaluation after the guidance is coherent.

## Verified requirements

The runtime registry still contains 86 controls: 81 public and five hidden internal controls. All public identities have exactly one table row in the guide; internal identities have their own table. Each skill links appropriate sections. The information-model reference retains the meanings and limits of evidence, while command selection has one reference owner.

Source/index prerequisites were checked against the common database handler, specific dispatch paths and a disposable never-indexed repository. With automatic watching and expensive rebuilding disabled, `files`, `search`, `code`, `inspect` and `outline` failed at index preparation. `system --source`, `health`, and Git-based `review` succeeded. This is a current CLI dependency even for commands reading current bytes; no source-only support is implied for them in the guide.

Health baseline flags select the indexed path without requiring an explicit `--indexed`; baseline writing is a mutation. Suppression recording can work without an index, while graph evidence attempts to attach a generation receipt. The guide preserves these distinctions.

## Later implementation/consolidation candidates

- Decouple exact current-text/path reads from index preparation where compiler identity is not required. The cold-repository probe demonstrates the current limitation; this change only documents it.
- Review whether `drift` needs a separate entry point: its default unused-import/architecture shortlist overlaps other reports. Preserve its module context or explicitly retire it; optional sibling-pattern deviations are a weaker, distinct signal.
- Review the `complexity` entry point alongside source health/review. It includes per-symbol connectivity but uses a different metric contract. Do not silently present its estimate as the source diff's cognitive/cyclomatic/coverage measurement.
- Retain distinct reference/import/call views and variable-slice/split-candidate views in this change. They answer different questions and cannot be removed merely because their inputs look similar. Framework-specific commands let an agent target one candidate analysis instead of running an aggregate report.

These are follow-up candidates, not verified equivalence or automatic deletion decisions.

## Validation

- Runtime registry comparison: all 81 public commands have exactly one guide row; all five internal controls are listed separately.
- All six skills link the guide. The repository skill-link check and an additional check of 16 guide links and section anchors passed.
- Existing CLI contract, setup and agent-setup tests: 60 passed, zero failed.
- A disposable cold-repository probe confirmed the source/index prerequisites described above.
- `diff-impact --base HEAD` reported no changed indexed symbols or affected consumers for these documentation changes. This does not validate the prose; registry comparison and handler inspection supply that evidence.
- `git diff --check` passed. The full runtime suite and build were not repeated because this change only updates documentation and skills.

Delivery is one documentation commit on main. The unrelated untracked LaunchPoint validation report remains outside this change. The cheaper-model task comparison has not run as part of this work.
