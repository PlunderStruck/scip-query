# The Ways AI Coding Rots a Codebase — and the Detector Built for Each

AI-assisted development fails in _specific, repeatable_ ways. None of them are
visible in a single file, which is why linters and code review miss them: every
one lives in the relationships between files — the reference graph, the git
change graph, or the gap between docs and code. Each failure mode below names
the behavior, the detector built for it, exactly how to run it, and how to wire
it in so it gets caught automatically.

Every detector is evidence-ranked and honest about confidence: graph facts vs
heuristic candidates are labeled, and heuristic output always says so.

---

## 1. Re-implementing code that already exists

**What the agent does:** it can't see the whole repo, so it writes a helper,
hook, composable, or frontend component that already exists - a date formatter,
a retry wrapper, a validation guard, a table toolbar. Now there are two implementations that drift independently until they
contradict each other.

**The detector:** `recent-duplicates` makes similarity _directional_ using git
file ages - which side is the established original, which is the freshly-added
echo.

Illustrative output:

```
91%  ECHO  react-component  src/components/ProjectCardVisual.tsx  ProjectCardVisual  (added 62 commits ago)
     duplicates established  src/pages/HomePage.tsx  RecentProjectRow()
     basis: jsx-structure
```

**Use it:**

```bash
scip-query recent-duplicates              # after any AI session
scip-query similar <closest-existing-fn>  # BEFORE writing a new helper
```

**Caught automatically by:** the `echo` check in `diff-gate` — flags any
changed symbol that is ≥80% similar to established code elsewhere.

## 2. Duplicating itself within one session

**What the agent does:** generates the same function in two places during one
session — neither copy is "established," both are new, and they diverge from
day one.

**The detector:** `recent-duplicates` reports these as **TWIN** (both sides
inside the recency window) and tells you to pick one before they drift:

```
100% TWIN  src/workflows/a.ts ensureAccessible() / src/workflows/b.ts ensureAccessible()
```

**Use it:** `scip-query recent-duplicates` at the end of every agent session.

## 3. Extracting a helper but only migrating some call sites

**What the agent does:** creates an abstraction, rewires one or two call
sites into it, and abandons the rest — the extracted logic survives inline at
every site it missed. The codebase ends up with the worst of both worlds: an
abstraction _and_ the duplication it was meant to remove.

**The detector:** `incomplete-migration` finds symbols that are new at the
base ref, confirms they were wired into at least one site, then reports
established untouched functions whose callee sets _contain_ the helper's
(containment scoring, because a missed site holds the helper's logic plus its
own — symmetric similarity under-scores exactly these):

```
src:demo:summarize:recordScore()  (src/demo/summarize.ts)
  wired into: src/demo/report-a.ts
  un-migrated: 100%  buildReportB()  (src/demo/report-b.ts)
  un-migrated: 100%  buildReportC()  (src/demo/report-c.ts)
```

**Use it:**

```bash
scip-query incomplete-migration                       # after any extraction
scip-query incomplete-migration --base origin/main    # gate a whole branch
```

**Caught automatically by:** the `incomplete-migration` check in `diff-gate`.

## 4. Writing code that never gets wired up

**What the agent does:** builds the function, the type, the handler — and
never connects it. Or it _was_ connected, then a later session rewired the
flow and left the original dangling. Dead code that looks intentional.

**The detectors:** `dead` (evidence-ranked, entrypoint-aware), and the
`new-dead` check in `diff-gate` that catches it _at the moment of creation_:

```
[new-dead] resolveTheme (src/theme.ts) was changed but has zero indexed consumers
  -> Wire it up, or remove it before it becomes permanent dead code.
```

**Use it:**

```bash
scip-query dead --min-loc 10 --skip-barrels
scip-query isolated                # whole files nothing imports
```

## 5. Speculative generality — options and parameters "for later"

**What the agent does:** adds trailing parameters, option bags, and config
flags for futures that never arrive. Every one is permanent API surface that
every future reader has to understand.

**The detectors:** `unused-params` (trailing parameters no body uses, scoped
to removals that are type-safe by construction), plus the abstraction-level
versions: `wrapper-candidates` (functions that only forward),
`passthrough-candidates` (layers that add nothing), and `stale-abstractions`
(interfaces/bases with a single implementation).

**Use it:**

```bash
scip-query unused-params
scip-query wrapper-candidates
scip-query stale-abstractions
```

**Caught automatically by:** the `unused-params` check in `diff-gate`.

## 6. Letting the standards docs lie

**What the agent does:** nothing — that's the problem. You write in-repo
standards _for_ agents; the code moves on; the doc doesn't. The next agent
reads the doc and faithfully implements against a dead spec. A stale standard
is worse than none.

**The detector:** `doc-drift` reads every doc's file citations _and_ its
co-change history, and flags docs whose referenced code kept changing after
the doc stopped — including broken references to files that no longer exist.

Illustrative output:

```
staleness 94  product/domain-model.md
  BROKEN REFERENCE: cites src/api/servicePlans.ts — that file no longer exists
  22 change(s) since doc update  src/workflows/serviceTasks.ts
```

**Use it:** `scip-query doc-drift`, then run the `scip-improve` documentation-reconciliation scenario to
drive staleness to zero (it updates descriptive claims and _escalates_
normative violations instead of silently blessing them).

**Caught automatically by:** the `doc-reference` check in `diff-gate` — a doc
cites a file you changed and wasn't updated in the same diff.

## 7. Editing one side of an invisible contract

**What the agent does:** changes the schema but not the generated inventory;
the `.env.example` but not its parser; the API contract but not the frontend
store. The reference graph can't see these pairs — no import connects them —
but git history can: they've changed together in 12 of the last 14 commits.

**The detector:** `co-change` finds file pairs that repeatedly change in the
same commits with _no_ dependency edge.

**Use it:**

```bash
scip-query co-change                       # repo-wide hidden coupling
scip-query co-change src/db/schema.prisma  # partners of one file
```

**Caught automatically by:** the `co-change-partner` check in `diff-gate`:

```
[co-change-partner] schema.prisma changed, but scripts/scope-inventory.mjs did not — they change together 12x (86%)
```

## 8. Deleting things that are still used — or refusing to delete at all

**What the agent does:** both. It deletes a "dead" function that a dynamic
path still references, or it hoards code because it can't prove anything is
safe to remove.

**The detector:** `cleanup-plan` runs dead-code analysis to a _fixpoint_ —
deleting batch 0 makes batch 1 dead, and the plan shows the cascade. Then
`--verify` applies each batch in a throwaway git worktree and runs **your own
compiler** (tsc, cargo, go, python oracles — differentially, so pre-existing
errors don't drown the signal).

Illustrative output:

```
── Batch 0: deletable now (graph-fact, 67 LOC) ──
Batch 0: COMPILER-VERIFIED
```

When verification fails, the errors name the exact references the static
evidence missed. Delete with a proof in hand, not vibes.

**Use it:**

```bash
scip-query cleanup-plan --verify
```

## 9. Making every change blind to its blast radius

**What the agent does:** edits a symbol without knowing who consumes it, what
breaks transitively, or which files historically move together with it — then
"finishes" with three consumers silently broken.

**The detectors:** `plan-context` (one command bundling definitions,
references, call graph, blast radius, churn, and co-change partners — the
pre-edit briefing), `change-surface`, `affected`, `diff-impact --json`.

**Use it:**

```bash
scip-query plan-context <symbol-or-file>   # before the edit
scip-query diff-impact --json              # after the edit
```

The `scip-plan` skill enforces this end-to-end: every step in a plan must
cite the scip-query command that verified it.

## 10. Slow quality decay nobody notices

**What the agent does:** each session adds a little rot. No single diff is
alarming; six weeks later the repo is unrecognizable.

**The detector:** the ratchet. `health --write-baseline` snapshots finding
identities into a committable file; `health --baseline` exits 1 on any _new_
finding. "Don't get worse" becomes an objective gate no score arithmetic can
game.

**Use it:**

```bash
scip-query health --write-baseline   # once, committed
scip-query health --baseline         # in CI
```

**Caught automatically by:** the `baseline` check in `diff-gate`.

---

## Wiring it all up so nobody has to remember any of this

The detectors only help if they run. Three layers, in increasing strength:

**1. Skills and lifecycle hooks (routing).** Installing scip-query symlinks the
bundled skills into `~/.agents/skills/`, `~/.claude/skills/`, and
`~/.codex/skills/` — they update automatically with the package. Project setup
writes reviewable checkout-local hooks to `.codex/hooks.json` and
`.claude/settings.local.json` and excludes both through `.git/info/exclude`.
The deprecated `setup-hooks --shared` flag remains parse-compatible but no
longer writes tracked settings. Set `SCIP_QUERY_SKIP_HOOK_INSTALL=1` or run
`scip-query setup --no-hooks` to skip lifecycle hook setup. The hooks add
scip-query context at session start, route prompts toward the right specialist,
and run a safe Stop hook wrapper around the diff gate only for that repository.
The Stop hook sends feedback to the agent by default; set
`SCIP_QUERY_STOP_HOOK_MODE=warn` for warning-only output or
`SCIP_QUERY_STOP_HOOK_MODE=block` to enforce the gate. Run
`scip-query setup-hooks --json` to repair the current repo's hooks.

**2. Project setup and guidance.** Run once per project:

```bash
scip-query setup --json
```

Setup installs or refreshes skills, configures project-local hooks, checks indexer readiness, attempts
configured indexer remediation, refreshes the index, smoke-tests representative
commands, writes `docs/scip-query/health-dossier.md` and `.json`, reports the
health score and items needing attention, and seeds a managed block in
`AGENTS.md` plus a `CLAUDE.md` import shim.

The generated guidance distinguishes shared repository records from local
preferences. Commit suppression files and `.scipquery/ledger/` outcome events
with the change that produced them. Never commit the checkout hook files.

After setup, use `scip-audit` to confirm raw signals and
`scip-improve` when the user wants the agent to fix the worst confirmed
items until the health score is as high as reasonably possible.

**3. The gate (enforcement).**

```bash
scip-query diff-gate --json          # default diff-scoped checks, exit 1 on findings
scip-query diff-gate --json --baseline  # include the health-baseline ratchet
scip-query setup-agent --git-hook    # pre-commit backstop: fires whoever wrote the diff
```

<!-- BEGIN GENERATED DIFF-GATE CHECKS -->
| Check | What it catches | When it runs |
| --- | --- | --- |
| `echo` | Changed symbols that newly echo established code elsewhere. | Default diff gate. |
| `incomplete-migration` | New helpers or abstractions wired into some sites while older inline sites remain. | Default diff gate. |
| `co-change-partner` | Historically coupled files that usually change together but are missing from this diff. | Default diff gate. |
| `twin-partner` | A changed symbol has a same-(near-)name twin (identical or already-divergent) elsewhere that this diff left untouched. | Default diff gate. Advisory: findings print but never cause a nonzero exit by themselves. |
| `coverage-contract` | A configured `coverageContracts` entry (.scipquery.json) drifted: its declared key set no longer matches its ground-truth source. | Default diff gate, only when either side of a configured contract changed. |
| `architecture` | A declared architecture boundary rule has a violation absent from the committed health baseline. | Default diff gate when closed dependency rows, requireCompletePolicy, requireAcyclic, requireResolvedBoundaries, requireMinimalPolicy, maxBoundaryFanOut/maxBoundaryFiles, or testPaths are configured and a baseline exists. |
| `doc-reference` | Docs that cite changed files and may need a matching update. Dated snapshot docs (docs.snapshotPaths) are excluded by policy. | Default diff gate. Advisory (21.2) for bare file-mention citations; blocking when the citation has a line anchor or the cited file was deleted/renamed. |
| `unused-params` | Fresh trailing parameters or options that no changed body uses. | Default diff gate. |
| `new-dead` | Changed production symbols with zero indexed consumers. | Default diff gate. |
| `baseline` | New health finding identities compared with the committed health baseline. | Only with `diff-gate --baseline`. |
<!-- END GENERATED DIFF-GATE CHECKS -->

Every finding ships with a remediation an agent can act on without human
triage. The installed Codex/Claude Stop hook uses the same diff-gate evidence,
warns by default, and no-ops outside indexed scip-query workspaces, so global
hook install stays safe for ordinary projects.
