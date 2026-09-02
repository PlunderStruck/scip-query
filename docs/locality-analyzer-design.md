# Locality Analyzer Design

This document designs the missing analyzer family identified during the analyzer inventory: a tool that evaluates where extracted code belongs. It is intentionally a design document, not a production implementation.

The problem shows up most clearly after React or Vue large-component work. An agent can reduce a large file by extracting components, hooks, helpers, or composables, but it may dump all of them into a flat folder beside the original file. That can make the size metric better while making ownership, reuse, and navigation worse.

## Core Concepts

Code locality is the placement relation between a source unit and the files that use it. It concerns real files, directories, imports, consumers, tests, and package boundaries; its essential characteristic is that code belongs at the nearest stable home that all legitimate consumers can reach without making the API broader than the concept deserves.

A source unit is a file, symbol, component, hook, composable, type, or helper that the analyzer can name and trace. It is the smallest unit whose placement can be judged from references, imports, and directory structure.

A consumer set is the set of files or symbols that import, call, render, instantiate, or otherwise rely on a source unit. Its essential role is to reveal whether a unit is private to one place, shared within a feature, shared across a domain, or actually reusable across the application.

An ownership boundary is a directory, package, route, feature, domain, or module boundary that indicates who should be allowed to change a unit. It is not just a path prefix; it is the codebase's visible grouping of reasons to change.

An abstraction level is the height of a unit's meaning relative to product code. A button primitive, route panel, invoice calculation, GraphQL client, and test fixture can all be TypeScript functions or components, but they belong at different levels because they serve different kinds of callers.

A shared folder is a directory whose name or import pattern says that multiple nearby units may depend on it. Its essential risk is that it can either preserve local reuse or become a dumping ground that erases ownership.

A global shared folder is a repository-wide shared directory such as `src/shared`, `src/lib`, `src/components`, or `packages/shared`. Its essential risk is API inflation: code placed there becomes easier to depend on from anywhere, so the placement should require cross-feature or cross-package evidence.

## Command Shape

Proposed command:

```sh
scip-query locality-candidates [symbol-or-file]
```

Useful options:

```sh
scip-query locality-candidates apps/web/src/routes/HorsesView.tsx --json
scip-query locality-candidates --scope apps/web/src --since HEAD~20
scip-query locality-candidates --changed-only --base origin/main
```

The command should be report-only at first. Its action tier is contextual signal: it guides placement and review, but it should not move files automatically.

## Inputs

The analyzer should combine existing evidence rather than invent a separate world model.

| Input                         | Source                                                                              | Why it matters                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Candidate source unit         | Explicit argument, changed files, large component/view pressure, extract candidates | Chooses what placement is being judged                                |
| Consumer files and symbols    | `refs`, `imported-by`, `rdeps`, call graph, JSX/Vue render facts                    | Shows who actually uses the unit                                      |
| Current path and import path  | filesystem path, import graph                                                       | Reveals whether the unit is already local, feature-shared, or global  |
| Nearest common ancestor       | consumer file paths                                                                 | Finds the smallest directory all consumers share                      |
| Feature and route roots       | path names such as `routes`, `pages`, `features`, `modules`, `domains`              | Distinguishes product areas from generic infrastructure               |
| Package or workspace boundary | package manifests, tsconfig references, workspace layout                            | Prevents app-local concepts from leaking into shared packages         |
| Test adjacency                | test file paths and references                                                      | Keeps test helpers near their tests unless production consumers exist |
| Naming evidence               | source unit name, directory names, imported symbols                                 | Distinguishes product concepts from generic primitives                |
| Historical co-change          | `co-change`, git history                                                            | Shows whether the unit changes with one feature or several            |
| Existing local conventions    | sibling folder names and import patterns                                            | Avoids recommendations that fight the codebase's own organization     |

## Placement Tiers

| Tier                   | Recommendation                                         | Strong evidence                                                                           | Common mistake caught                                                                |
| ---------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `same-file`            | Keep the unit in the original file.                    | One consumer, no independent tests, name only makes sense inside the parent.              | Extracting a private branch into a needless helper file.                             |
| `sibling-private`      | Put it next to the parent in a private local folder.   | Two or more consumers under one page/component folder, no outside imports.                | Creating a route-local `components` folder under global `src/components`.            |
| `feature-local-shared` | Put it under the nearest feature/module shared folder. | Consumers span files in one feature root but not outside it.                              | Moving feature-specific hooks into app-wide `shared`.                                |
| `domain-shared`        | Put it under a domain or bounded context folder.       | Consumers cross feature roots but share domain nouns and co-change history.               | Duplicating business rules in several features or over-generalizing them into `lib`. |
| `app-shared`           | Put it under app-level shared UI or utility space.     | Consumers cross domains inside one app and the name is generic enough for app reuse.      | Keeping a genuinely reusable primitive hidden inside one feature.                    |
| `package-shared`       | Put it in a shared workspace package.                  | Consumers cross package/workspace boundaries, and package API ownership is intended.      | Importing across workspace internals or copying contracts between packages.          |
| `no-extraction`        | Do not extract, or inline it back.                     | One consumer, weak name, no independent concept, extraction only satisfies a size metric. | Size-score gaming through thin files and local indirection.                          |

The output should include confidence, reasons, counterevidence, and the exact consumer set.

```json
{
  "candidate": "apps/web/src/features/horses/HorseStatusPanel.tsx",
  "currentTier": "app-shared",
  "recommendedTier": "feature-local-shared",
  "confidence": "medium",
  "consumers": ["apps/web/src/features/horses/HorseProfile.tsx", "apps/web/src/features/horses/HorseList.tsx"],
  "nearestCommonAncestor": "apps/web/src/features/horses",
  "reasons": [
    "all production consumers are inside one feature root",
    "candidate name uses the Horses domain noun",
    "no package or cross-domain consumers found"
  ],
  "counterevidence": ["component name is presentational enough that future app-level reuse is possible"],
  "suggestedHome": "apps/web/src/features/horses/components/HorseStatusPanel.tsx"
}
```

## Analyzer Pairing

The locality analyzer should not replace existing analyzers. It should complete their story.

| Existing analyzer                                    | What it says today                               | Locality companion question                                                                           |
| ---------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `react-large-component-pressure`                     | This React component is too large.               | If pieces are extracted, which ones are private, feature-local, or shared?                            |
| `vue-large-view-pressure`                            | This Vue SFC is too large.                       | Should extracted child components/composables live beside the view, in the feature, or in app shared? |
| `extract-candidates`                                 | This function has a region of exclusive callees. | Would the extracted helper have one real owner or a broader consumer set?                             |
| `react-hook-candidates`, `vue-composable-candidates` | Several components repeat behavior.              | Is the hook/composable local to one feature or reusable across domains?                               |
| `recent-duplicates`, `echo`                          | New code duplicates older code.                  | Which existing owner should the new code reuse, and would reuse widen the wrong API?                  |
| `incomplete-migration`                               | A helper extraction stopped halfway.             | Is the helper in the right place for all remaining call sites?                                        |
| `co-change`                                          | Files move together historically.                | Does history imply a hidden shared owner or only a local synchronization point?                       |

## Algorithm Sketch

1. Resolve the candidate to a file or symbol.
2. Collect direct consumers through references, imports, render facts, and reverse dependencies.
3. Remove consumers that are tests unless the candidate is test-only.
4. Compute the nearest common ancestor of production consumers.
5. Identify boundary markers in and above that ancestor: `app`, `apps`, `packages`, `routes`, `pages`, `features`, `modules`, `domains`, `shared`, `components`, `hooks`, `composables`, `lib`, `utils`, `services`, `stores`, and `contracts`.
6. Classify the current home and the smallest legitimate home.
7. Compare names from the candidate, directories, and consumers to decide whether the concept is domain-specific or generic.
8. Check workspace/package boundaries to prevent cross-package leakage.
9. Use co-change history as supporting evidence, not as a hard rule.
10. Emit a recommendation only when the consumer set and boundary evidence agree.

The first implementation can avoid automatic tree moves entirely. The valuable output is a review-grade explanation: "this extracted component is global today, but all consumers are in one feature, so feature-local shared is the smallest honest home."

## Precision Rules

The analyzer should prefer "no confident recommendation" over pretending all placement is obvious.

Report `same-file` or `no-extraction` when a candidate has one consumer and no independent concept name.

Report `sibling-private` when all consumers sit below one component, route, or view folder and no outside production import exists.

Report `feature-local-shared` when consumers share a feature root and imports do not cross into other feature roots.

Report `domain-shared` only when path names, symbol names, or co-change evidence show the same product domain across multiple feature roots.

Report `app-shared` only when consumers cross domains inside one app and the unit is not named after one feature.

Report `package-shared` only when consumers cross package boundaries and package exports make that sharing intentional.

Downrank a recommendation when imports come only through barrels, tests are the only second consumer, the candidate name is generic but behavior is domain-specific, or the nearest common ancestor is the repo root.

## Skill-First Option

Before production implementation, this can ship as a bundled workflow skill.

Proposed skill name:

```text
scip-locality-review
```

The skill would tell agents to run:

```sh
scip-query context <target> --full
scip-query imported-by <symbol>
scip-query rdeps <file>
scip-query co-change <file> --full
scip-query react-large-component-pressure <scope> --full
scip-query vue-large-view-pressure <scope> --full
```

Then it would require the agent to answer:

1. What is the exact consumer set?
2. What is the nearest common owner all consumers share?
3. Is the concept product-specific, feature-specific, app-generic, or package-level?
4. Does the current path make the API wider than the consumer set requires?
5. Would a move reduce imports and ownership confusion without creating a new global dumping ground?

This is a good first step because it turns the product question into a repeatable checklist while we gather validation labels for the eventual command.

## Validation Plan

Use the validation corpus from `docs/analyzer-validation-protocol.md` and track the work under `docs/analyzer-validation-ledger.md`.

For React, inspect Vega_2.0 large components and hook candidates. A true positive is a recommendation that would place an extracted unit closer to its actual consumers without hiding a real shared primitive.

For Vue, inspect Stable_Management large views and composable candidates. A true positive is a recommendation that distinguishes route-local child components from feature-level composables and app-level UI primitives.

For scip-query itself, inspect analyzer/helper extractions. A true positive is a recommendation that keeps detector-private helpers near their detector unless multiple detector families actually consume them.

For Rust smoke coverage, run the command only after SCIP data supports the same source-unit questions. Until then, locality validation on Rust should be marked unsupported rather than failed.

Validation result: `docs/validation/2026-06-21-locality-analyzer-validation-result.md` recommends a report-only or skill-first implementation, with `actionTier: "signal"` and explicit consumer-coverage caveats. React `.tsx` samples had usable `rdeps` evidence, but Vue SFC samples had weak reverse-dependency coverage, so the first implementation must not recommend concrete destinations unless exact consumers are known.

## Score Integration

Locality findings should not immediately reduce health like dead code. They are contextual signals.

The health score can later use them as signal backlog pressure when they combine with other evidence:

- Large component pressure plus globalized local children.
- Extract candidates plus one-consumer helper files.
- Recent duplicates plus a clear existing local owner.
- Co-change clusters plus no shared owner directory.

The score should not punish a single "could be more local" suggestion. It should punish repeated evidence that code organization is being flattened until ownership is unclear.
