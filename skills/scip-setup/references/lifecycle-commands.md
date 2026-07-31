# Lifecycle commands

`setup` runs most of these internally during a full bootstrap. Reach for one
directly when only a slice of the footprint needs installing, refreshing, or
removing — not a full re-bootstrap.

## install-skills

```bash
scip-query install-skills
```

When: bundled skills are missing, out of date after a scip-query upgrade, or
a new agent root (Claude Code, Codex, or a shared agent root) needs the skill
set that another root already has. Installs `_shared`, `scip-query`,
`scip-setup`, and the consolidated workflow family into Claude Code, Codex, and
shared agent roots.

Output to check: the list of skills written or linked per root. Confirm no
root was silently skipped — an agent root present in the repo but absent from
the output means that root did not get the skills.

## setup-agent

```bash
scip-query setup-agent
```

When: `AGENTS.md`/`CLAUDE.md` has no block pointing agents at the scip-query
skills and diff gate, or the block is stale relative to the installed
version. Seeds that guidance block, plus an optional git pre-commit backstop.

Output to check: the diff to `AGENTS.md`/`CLAUDE.md` — confirm the block was
added or refreshed in place rather than duplicated.

## setup-hooks

```bash
scip-query setup-hooks
```

When: project-local Codex or Claude Code lifecycle hooks are missing (never
installed, or wiped by a settings reset) or need refreshing after a
scip-query upgrade changed hook contracts.

Output to check: which hook files were written per tool; treat a tool with no
hook file as not covered. On a supported provider, confirm the installed
events cover session restoration, changed prompt state, compaction,
pre-tool safeguards, and Stop evaluation; partial lifecycle coverage is not an
autonomous workflow.

## setup-ci

```bash
scip-query setup-ci
```

When: the user explicitly asks for CI setup — do not run this unless asked.
Writes a GitHub Actions workflow that runs `scip-query reindex` and
`diff-gate` on pull requests.

Output to check: the workflow file path written. Tell the user to commit it
and confirm it triggers on the next PR; this command only writes the file, it
does not verify the workflow runs.

## check-deps

```bash
scip-query check-deps
```

When: you need a fast preflight on whether scip-query and the detected
language indexers are actually runnable, without running the full `setup`
sequence — for example, diagnosing a `doctor` complaint about a specific
indexer, or confirming an environment before a CI run.

Output to check: per-indexer runnable/not-runnable verdicts. A "not runnable"
verdict here is the reason to go fix that indexer before trusting any index
built from it.

## augment-sources

```bash
scip-query augment-sources
```

When: files are missing from the index even after a clean `reindex`, because
the upstream SCIP indexer for that language skips them (common for
non-source files, generated files it doesn't recognize, or files outside its
project graph). Adds those source files to the SQLite documents table
directly so source-fact queries can see them.

Output to check: the count and list of files added. If a file you expected is
still absent, it means the indexer skip reason is not one `augment-sources`
covers — investigate the specific file rather than re-running the command.

## capability-matrix

```bash
scip-query capability-matrix
```

Deprecated alias for `capabilities --matrix`. If you see this in an older
script or muscle memory, prefer `scip-query capabilities --matrix` directly —
same output, current name.

## uninstall

```bash
scip-query uninstall
```

When: the user wants scip-query's footprint removed from the repo —
decommissioning, or before trying an alternative tool. Removes
scip-query-owned skill links, project hooks, and managed agent setup blocks.

Output to check: confirm the removal list covers every artifact `setup`
reported writing (skills, hooks, agent guidance blocks). Anything `setup`
wrote that `uninstall` doesn't list as removed needs manual follow-up — for
example config files (`.scipquery.json`) and the SQLite index are intentionally
left in place since they may hold data the user still wants. Shared
`.scipquery` goals, changes, attempts, decisions, obligations, completion
records, suppressions, and events are repository history, not installation
artifacts; uninstall must preserve them.
