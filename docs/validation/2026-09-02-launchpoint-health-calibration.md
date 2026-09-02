# Health detector calibration on Launchpoint (2026-09-02)

Repository: `launchpoint-backend` (7,819 indexed files, 435k symbols, Next.js
app router + Trigger.dev + Drizzle, shadcn/ui). Tool: scip-query 0.23.0
before, this branch after. Every detector was run with `--full` and the complete
finding lists were classified by structural cause, not by sampling the top 20.

## Method

1. Dump every health detector's complete result (`--full --json`).
2. Partition each list by a structural property a reviewer could name
   (test file, vendored kit, framework convention, body shape, partner class).
3. Turn each partition that is a non-finding _by construction_ into a
   detector policy that removes the rows from the health count and discloses
   the removal (`Policy exclusions` in the text report, `policyExclusions` in
   `health --json`). Rows stay visible in the focused command, usually at
   support tier, so nothing disappears.
4. Re-run and compare.

## What the complete lists showed

| Detector                       | Before                                                | Structural cause                                                                                                                                                                                        | Policy                                                                                                               |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| react-component-duplicates     | 69 pairs                                              | 25 pairs involved test files; 7 pairs were two shadcn primitives; 3 pairs were two route entries; 8 pairs were loading skeletons sharing only `Skeleton`                                                | test profiles excluded; kit pairs excluded; route pairs and skeleton pairs support tier                              |
| react-hook-candidates          | 242 pairs (135.5 weighted)                            | 48 generic-only pairs; 57 signal pairs shared nothing but `useEffect`/`useState` plus a `.mutate()` call that the classifier read as a domain term; 19 hook-versus-component pairs; 4 route-entry pairs | framework hook and request vocabulary is generic; hook/component pairs excluded; only pairs with health weight count |
| react-large-component-pressure | 470 rows / 332 files                                  | 149 rows were components under 150 lines that qualified only by naming 80+ distinct JSX tokens                                                                                                          | token axes require the component to already be substantial (half the line threshold)                                 |
| wrapper-candidates             | 580 (405 weighted)                                    | only 73 bodies forward one call; 469 compute or branch; 38 were `<constructor>`                                                                                                                         | body shape tier; constructors excluded; helpers disclosed                                                            |
| duplicate-bodies               | 304 groups                                            | 19 constructor groups, 78 test-only groups, 21 route verb-export groups, shadcn members                                                                                                                 | members removed after grouping; a group must keep two product files                                                  |
| twin-drift                     | 575 groups                                            | `handler`/`handleGet`/`handlePost` across 188 route files, `*Page` across page files                                                                                                                    | route convention names excluded inside framework entry files; delegation check follows `import { x as y }` aliases   |
| co-change (hidden coupling)    | 141 pairs (32.5 weighted)                             | 37 doc-code pairs (`agent_docs/*.md` kept in sync with code by policy); the top pair was the Drizzle migration journal                                                                                  | doc-code and generated-artifact pairs disclosed, weight 0; the example pair is the highest-weighted one              |
| complexity-hotspots            | 141 extreme, pressure 47x over a fixed threshold of 3 | `Button()` (50 lines, 7 branches, 281 importers) counted as extreme; the threshold did not scale with size                                                                                              | extreme requires 10+ branches; pressure threshold is 0.5% of files (floor 3)                                         |
| dead                           | 206 symbols                                           | 115 were Trigger.dev task exports under `dirs` from `trigger.config.ts`; 26 were `drizzle-kit pull` relation dumps                                                                                      | task directories are entry surfaces; generated artifacts disclosed                                                   |

Things the lists did _not_ support changing: the 0.3 twin-drift similarity
floor (removing punctuation tokens moved real twins below the floor as often
as homonyms), passthrough candidates (the literal-forwarding gate already
holds), and stale abstractions (only the 5 unused ones score).

## Result

| Measure                          | Before       | After        |
| -------------------------------- | ------------ | ------------ |
| Health / risk / hygiene          | 48 / 86 / 48 | 66 / 88 / 66 |
| React component pairs            | 69           | 28           |
| React hook pairs (weighted)      | 242 (135.5)  | 49 (28.5)    |
| Large React components (files)   | 332          | 263          |
| Wrapper candidates (weighted)    | 580 (405)    | 73 (55)      |
| Duplicate body groups            | 304          | 181          |
| Twin drift groups                | 575          | 557          |
| Hidden coupling pairs (weighted) | 141 (32.5)   | 99 (21)      |
| Extreme complexity pressure      | 47x, −5      | 3.6x, −4     |
| Dead symbols                     | 206          | 65           |

Every removed row is listed under `Policy exclusions` with its count and
reason, and remains reachable through the focused command.

Genuine findings the calibration preserved: the dashboard/report analytics
widget copies (`SegmentedToggle`, `AudienceGenderDonut`, `AudienceBars`), the
three-way beat-list editor sharing `useStableListKeys`, the same-folder
`CreatorAvatar`/`CreatorRow` avatar copy, 105 copies of
`hasPvpSettlementSnapshotSql` and 42 of `hasDeliveredApprovedWorkSql`, and the
`api-to-form-values` / `form-values-to-api-payload` co-change pair.

## Second repository: Vega

Same build, `Vega_2.0` (2,712 files; Next.js web app plus a NestJS API in one
monorepo). Health 79 / 98 / 79. Exclusion classes on this repository: 36
test-file components, 12 hook-versus-component pairs, 23 pairs already covered
by a project hook, 117 single-consumer helpers, 8 kit duplicate members, 34
entry-surface dead symbols. All were checked against their rows and none
removed product-relevant findings. Two conventions this repository has and
Launchpoint lacks were added as policies afterwards: CRUD and lifecycle
method names shared across unrelated classes no longer form drifted-twin
groups, and files that forward three or more methods to the same
collaborator are treated as facades in `passthrough-candidates` (357 forwards
went from 171 direct to 38 direct). The graph-level work that came out of the
same investigation is tracked in `docs/plans/2026-09-02-graph-accuracy-investigation.md`.

## Callee tier follow-up (same day)

The occurrence-resolved callee tier recorded in
`docs/plans/2026-09-02-graph-accuracy-investigation.md` (lead 6) changes
what the callee-based detectors can see. Full-mode Launchpoint run with that
build, against the calibration run above (caches cleared, 7m49s):

| Finding               | Calibration | Callee tier | Read                                                       |
| --------------------- | ----------- | ----------- | ---------------------------------------------------------- |
| Complexity hotspots   | 173         | 191         | fan-out now counts calls through typed receivers           |
| Extraction candidates | 1027        | 1258        | isolated callee clusters need the edges to exist           |
| Similar pairs         | 198         | 209         | callee fingerprints are denser                             |
| Passthroughs          | 110 (62.75) | 123 (69.75) | literal forwards whose target the leaf path could not bind |
| Wrappers              | 73 (54.25)  | 73 (54.25)  | unchanged                                                  |
| React hooks           | 52 (31.5)   | 52 (31.5)   | unchanged                                                  |
| Dead code             | 65          | 65          | unchanged                                                  |
| Drifted twins         | 555         | 554         | unchanged within noise                                     |

Score 66 / 69 / 66. The risk axis differs from the calibration run's 87 only
because this run reports the five dependency cycles the original report also
had (cycles and cycle pressure, 18 points); the calibration run listed none.
`self-audit --samples 100` on the same index: references precision 1.0 /
recall 1.0; callees recall 1.0 over 13 compared with 218 occurrence-resolved
rows against 24 leaf-name rows; renders recall 1.0 over 91.

## Extraction candidates rebuilt (same day)

The extraction detector reported 1,258 rows in the full run above. Those rows
measured callees sharing a source line, not extraction seams (see lead 7 in
`docs/plans/2026-09-02-graph-accuracy-investigation.md`). With the rebuilt
detector the standalone full list is 930 rows: 438 signal-tier regions
(313 call regions, 125 rendered subtrees) and 492 support-tier regions whose
extraction would need more than five locals in or more than two back.
Signal regions are 20 lines at the median and 22% of their function.
In the full health run (profile: functions of at least 15 lines with at least
5 callees) the finding is 483 signal-tier candidates against 1,258 before,
with 504 support-tier regions disclosed under policy exclusions. The score
did not move on this axis because extraction pressure only deducts above one
percent of symbols.
