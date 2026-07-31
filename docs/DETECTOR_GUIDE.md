# Which Detector Do I Want?

scip-query has several detectors that sound alike but answer different
questions. This guide explains what each one actually measures, the
differences inside each confusable cluster, and which check to run after which
kind of change. (The companion doc [AI_FAILURE_MODES.md](AI_FAILURE_MODES.md)
maps these to the agent behaviors that create the problems.)

---

## Cluster 1 — "This structure shouldn't exist" (the speculation family)

Same disease — structure built for a future that never came — detected at
four different altitudes:

| Command                  | Altitude                    | What it measures                                                                                                                                                                 | The fix                                                                                           |
| ------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `unused-params`          | **parameter**               | Trailing parameters no body ever uses. TS/JS only, trailing-run only — removals that are type-safe by construction. `_`-prefixed and externally-published signatures are exempt. | Delete the parameters and their call-site arguments.                                              |
| `passthrough-candidates` | **function (fan-out view)** | Functions with exactly **one callee** and a small body — they just forward arguments to the real implementation.                                                                 | Inline it: call the target directly.                                                              |
| `wrapper-candidates`     | **function (fan-in view)**  | Symbols with exactly **one caller** — indirection that provides no reuse. Strongest when the sole caller is itself widely used.                                                  | Fold the body into the caller.                                                                    |
| `stale-abstractions`     | **type**                    | Classes, interfaces, and type aliases with 0–1 _real_ cross-file consumers (barrel re-exports don't count as consumers). Single-implementation interfaces, misplaced types.      | De-abstract: replace the interface with the concrete thing, or move the type to its one consumer. |

How to keep them straight:

- `passthrough` looks **down** (what does this function call? one thing) —
  `wrapper` looks **up** (who calls this function? one caller). A function can
  be both: a one-line forwarder with a single caller is the purest bloat.
- `unused-params` is _inside_ a signature; the other three are _about whole
  symbols_.
- `stale-abstractions` is the only one about **types**, not behavior. Note its
  confidence ranking: a single-consumer `class` is usually deliberate
  encapsulation (low), a single-consumer `interface` is worth questioning
  (medium), a zero-consumer type is just dead (high).

## Cluster 2 — "This already exists" (the similarity family)

All of these find duplication, but at different granularities and with
different evidence — and two of them add _direction_:

| Command                | Granularity                          | Evidence                                                   | Question it answers                                                                                         |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `similar <symbol>`     | function                             | callee-fingerprint cosine (TF-IDF), source-token fallback  | "What else does roughly what this function does?"                                                           |
| `similar-signatures`   | function                             | normalized parameter + return types                        | "What has the same _shape_, regardless of body?"                                                            |
| `similar-files`        | file                                 | Jaccard on import/dependency profiles                      | "Which files are copy-paste variants of each other?"                                                        |
| `similar-chains`       | pipeline                             | edit distance on infrastructure-filtered dependency chains | "Which end-to-end flows are parallel re-implementations?"                                                   |
| `recent-duplicates`    | callable/frontend unit + **git age** | callable, React, and Vue similarity + file-add history     | "Which side is the established original, which is the fresh echo?" (ECHO = new copies old; TWIN = both new) |
| `incomplete-migration` | function + **git diff**              | callee _containment_ vs new-in-diff helpers                | "I just extracted a helper — which call sites still have the logic inline and were never migrated?"         |
| `convergence <a> <b>`  | a known pair                         | shared/unique callees                                      | "I already know these two overlap — give me the merge prescription."                                        |

How to keep them straight:

- Use `similar` when you have **one symbol** in hand; `similar-files` /
  `similar-chains` for repo-wide sweeps at coarser grain;
  `similar-signatures` when implementations differ but the shape repeats.
- `recent-duplicates` is duplicate evidence **plus direction in time** - it tells you
  which copy to delete. Run it after agent sessions. It covers generic callables,
  React component structure, React hook behavior, Vue template structure, and
  Vue composable-like behavior.
- `incomplete-migration` is the **inverse of an echo**: the _new_ code is the
  canonical one (the helper you just extracted), and the _established_ code is
  what should disappear. It also scores by containment, not symmetric
  similarity, because an un-migrated site holds the helper's logic _plus_ its
  own — cosine under-scores exactly those.
- `extract-candidates` is the **before** picture: seams inside one big
  function that _should_ become a helper. `incomplete-migration` is the
  **after** picture: you made the helper but didn't finish moving everyone
  onto it.

## Cluster 3 — "Things drifting apart" (the drift family)

Three detectors share the word "drift" or the concept; they watch different
gaps:

| Command     | Watches the gap between                           | Evidence                                                                                                      |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `drift`     | a file and its **siblings/declared architecture** | reference graph: unused imports, project-owned forbidden boundary edges, "no sibling imports this" deviations |
| `doc-drift` | **docs** and the code they describe               | doc file-citations + doc↔code co-change history; flags broken references and staleness scores                 |
| `co-change` | two **files** with an invisible contract          | git history: pairs that change together with no dependency edge                                               |

How to keep them straight: `drift` is structural and intra-code, `doc-drift`
is prose-vs-code, `co-change` is code-vs-code where the connection exists only
in commit history. The diff gate includes doc/code and hidden-coupling coverage
through the `doc-reference` and `co-change-partner` checks; run `drift
--architecture` when you need direct dependency-rule findings beside boundary
coverage, reciprocity, and connected-group signals.

<!-- BEGIN GENERATED DIFF-GATE CHECKS -->

| Check                  | What it catches                                                                                                                   | When it runs                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `echo`                 | Changed symbols that newly echo established code elsewhere.                                                                       | Default diff gate.                                                                                                                                                                                                                                     |
| `incomplete-migration` | New helpers or abstractions wired into some sites while older inline sites remain.                                                | Default diff gate.                                                                                                                                                                                                                                     |
| `co-change-partner`    | Historically coupled files that usually change together but are missing from this diff.                                           | Default diff gate.                                                                                                                                                                                                                                     |
| `twin-partner`         | A changed symbol has a same-(near-)name twin (identical or already-divergent) elsewhere that this diff left untouched.            | Default diff gate. Advisory: findings print but never cause a nonzero exit by themselves.                                                                                                                                                              |
| `coverage-contract`    | A configured `coverageContracts` entry (.scipquery.json) drifted: its declared key set no longer matches its ground-truth source. | Default diff gate, only when either side of a configured contract changed.                                                                                                                                                                             |
| `architecture`         | A declared architecture boundary rule has a violation absent from the committed health baseline.                                  | Default diff gate when closed dependency rows, requireCompletePolicy, requireCompleteCoverage, requireAcyclic, requireResolvedBoundaries, requireMinimalPolicy, maxBoundaryFanOut/maxBoundaryFiles, or testPaths are configured and a baseline exists. |
| `doc-reference`        | Docs that cite changed files and may need a matching update. Dated snapshot docs (docs.snapshotPaths) are excluded by policy.     | Default diff gate. Advisory (21.2) for bare file-mention citations; blocking when the citation has a line anchor or the cited file was deleted/renamed.                                                                                                |
| `unused-params`        | Fresh trailing parameters or options that no changed body uses.                                                                   | Default diff gate.                                                                                                                                                                                                                                     |
| `new-dead`             | Changed production symbols with zero indexed consumers.                                                                           | Default diff gate.                                                                                                                                                                                                                                     |
| `baseline`             | New health finding identities compared with the committed health baseline.                                                        | Only with `diff-gate --baseline`.                                                                                                                                                                                                                      |

<!-- END GENERATED DIFF-GATE CHECKS -->

Baseline identities use `detector:file:shortName`. File or symbol renames can legitimately show as one fixed baseline identity plus one new identity; update the baseline after reviewing intentional renames.

## Cluster 4 — "Nothing uses this" (the deadness family)

| Command        | Scope       | Question                                                                                                              |
| -------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `dead`         | symbols     | "What has zero consumers?" (evidence-ranked, entrypoint-aware)                                                        |
| `isolated`     | callables   | "What is fully disconnected — no callers _and_ no callees?"                                                           |
| `cleanup-plan` | the cascade | "If I delete the dead stuff, what _becomes_ dead next — and will my compiler vouch for the whole batch?" (`--verify`) |

`dead` finds candidates; `isolated` finds the most extreme subset;
`cleanup-plan --verify` turns candidates into a compiler-proven deletion plan.
Don't hand-delete from `dead` output when `cleanup-plan` can prove it.

---

## After-the-change check matrix

The reflex to build (and the one the `scip-query` router skill teaches
agents): match the check to what the change _did_. `diff-gate` runs the
broad sweep on every diff; these are the targeted follow-ups.

| You just...                                           | Run                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Extracted a helper / created an abstraction           | `scip-query incomplete-migration` — did every site migrate?                                             |
| Wrote a brand-new helper or module                    | `scip-query similar <it>` and `scip-query recent-duplicates` — did it already exist?                    |
| Added parameters, options, or config flags            | `scip-query unused-params` — does anything use them yet?                                                |
| Added a forwarding/wrapper layer                      | `scip-query wrapper-candidates` and `scip-query passthrough-candidates` — does it earn its indirection? |
| Added an interface, base class, or type alias         | `scip-query stale-abstractions` — does it have more than one real consumer?                             |
| Changed a schema, contract, config, or generated file | `scip-query co-change <file>` — who historically moves with it?                                         |
| Changed code that docs describe                       | `scip-query doc-drift` — which docs now lie?                                                            |
| Deleted code                                          | `scip-query cleanup-plan --verify` — what else just became dead, and does the compiler agree?           |
| Anything at all, before saying "done"                 | `scip-query reindex && scip-query diff-gate`                                                            |

And before any non-trivial change: plan with `scip-query plan-context
<target>` (or the `scip-plan` skill, which requires a scip-query citation
for every claim in the plan).
