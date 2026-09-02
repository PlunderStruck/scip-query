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
