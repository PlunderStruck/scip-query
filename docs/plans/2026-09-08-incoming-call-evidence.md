# Incoming execution evidence loses compiler-resolved callers

Status: repaired and validated in the working tree. The earlier compiler-failure repair is preserved. The validated package was subsequently installed on the VM; see [installation and further graph findings](2026-09-08-graph-followup-and-vm.md). These changes remain uncommitted.

## Finding

An incoming execution query, which asks which source constructs can call a selected function, does not consistently use the compiler's resolved references. The outgoing and incoming projections can disagree about the same direct calls. Increasing depth, increasing the edge budget, and requesting `--full` did not restore the missing callers in this reproduction.

This matters for agents locating existing implementations and planning refactors: the graph can leave real consumers out of the agent's investigation. Its generic limitations do not identify these particular missing callsites.

## Reproduction

A fresh, disposable TypeScript repository used the actual public CLI and the current producer contract (version 2). Watching was disabled. No index artifact was edited or corrupted.

```ts
// owner.ts
export function target() { return 7; }

// barrel.ts
export { target as renamed } from './owner.js';

// calls.ts
import { target as alias } from './owner.js';
import { renamed } from './barrel.js';
import * as owner from './owner.js';
export function direct() { return alias(); }
export function throughBarrel() { return renamed(); }
export function throughNamespace() { return owner.target(); }
export function throughLocal() { const local = alias; return local(); }
export function throughObject() { const holder = { run: alias }; return holder.run(); }
export function invoke(callback: () => number) { return callback(); }
export function throughCallback() { return invoke(alias); }
```

After `scip-query reindex --allow-expensive-rebuild`:

- `evidence --at owner.ts:1 --edge execution --direction incoming --depth 1 --max-edges 30` reported only `direct -> target`.
- `refs` with the exact target symbol and `--full` reported compiler references at all three direct call lines, including the re-exported and namespace calls.
- Selecting `calls.ts:4`, `calls.ts:5`, and `calls.ts:6` together with outgoing execution at depth 2 reported all three direct calls to the same target identity.
- Incoming execution with depth 3, budget 100, and `--full` still omitted `throughBarrel` and `throughNamespace`. It additionally produced a region-level candidate; that does not identify either missing caller.
- The incoming packet reported `accounted`, zero omitted edges, and zero unsupported frontiers. `accounted` describes the generated topology, not complete program behavior; nevertheless, the known missing direct calls received no specific recovery disclosure.

A second case appended:

```ts
export function shadowed(alias: () => number) { return alias(); }
```

After another successful public reindex, incoming execution reported `shadowed -> target` as a **candidate**. The parameter is a separate binding from the imported `alias`; the target's complete compiler reference list correctly excludes the shadowed call on line 11. Running the transpiled fixture confirmed that the first six wrappers return 7, while `shadowed(() => 99)` returns 99. This candidate is not an asserted exact edge, but it is a preventable false lead where compiler binding information is available.

Local scratch artifacts, including source, public CLI exports/logs, and runtime results:

`/var/folders/4c/wsjvhgw90t7f31d7s68ddhtc0000gn/T/scip-query-call-coverage-kl3csdv7/`

The previously suspected omission of an ordinary direct caller on a clean two-file index did **not** reproduce on fresh current-build fixtures. It is not the basis of this finding.

## Observed implementation cause

- `src/queries/graph/system-map.ts:3902`, `systemMapReferenceSites`, starts from candidate files, identifies direct named imports, then scans matching identifier names rather than enumerating the selected symbol's resolved occurrences. Once a direct import alias is present, other spellings in that file are excluded from its name set.
- `src/queries/graph/system-map.ts:2483`, `sourceCallsiteTargetsDefinition`, accepts a matching leaf name or a direct named-import match. It does not verify the binding of that particular invocation. A renamed re-export fails the direct-import test; a parameter that hides the import can pass it incorrectly.
- `src/queries/graph/system-map.ts:1519`, `symbolReferenceEvidence`, combines those two results to classify incoming callsites. The outgoing path can already resolve the omitted direct calls, as demonstrated by the public CLI.

The local-variable and callback cases are additional scope to assess, not proof that every indirect invocation must be statically resolved. The local-variable outgoing packet explicitly disclosed partial local flow. Distinguish such disclosed limits from losing already resolved direct calls.

## Proposed repair and acceptance checks

### Existing flow and reuse decisions

The registered `evidence` query in `src/runtime/query-commands/navigation.ts:1515` validates explicit families, direction, depth, and output budget, then calls `graphEvidence`. That query calls `systemMapTopology`, projects the returned relationships, selects the requested direction, and materializes recoverable output folds. The graph runs against one opened database generation and uses database-scoped compiler/source caches; this repair does not change index publication or watcher ownership.

Within the topology builder, outgoing calls already use `scipOccurrenceCallTargetsForRange` in `src/symbols/graph/scip-occurrence-call-targets.ts`. It matches parsed invocation token ranges against compiler-resolved occurrence ranges, returning target identity plus availability and unresolved counts. Incoming traversal should use this same resolver. Exact reference lines are already exposed by `referenceOccurrenceLines` and used in the normal reference query. Reuse those APIs rather than introducing another import resolver or compiler invocation.

Legacy indexes without usable occurrence data currently retain candidate source evidence. Preserve the distinction between those candidates and compiler-bound calls, and disclose any remaining fallback limitations. Do not promote references passed as values into calls, or reinterpret unresolved indirect calls as proven absence.

Existing graph tests use `evidenceFixtureDb`; real compiler/CLI fixtures use isolated Git repositories with watching disabled, subprocess timeouts, and cleanup. Add a real-index public-command regression so mocked occurrence data cannot conceal the original failure. The fixture's expected callers must be stated independently of either graph direction.

### Ordered work

1. Add the real-index regression and verify that it fails against the existing build: mixed import spellings, parameter/local shadowing, references beside unrelated calls, and bounded output recovery.
2. Replace name-scanned reference lines with compiler reference lines when available, and classify incoming invocations through the shared occurrence resolver. Retire the superseded indexed-call name heuristic; keep weaker fallback behavior explicitly qualified.
3. Exercise the repaired public CLI and graph suites, assess failures and unresolved cases, then run full tests, type checks, lint, current-source review, and fresh diff impact. Update this record with actual results and any justified limits.

### Implementation findings

The initial real-index regression failed four checks against the previous build (missing callers, false candidates, and incomplete budget recovery); its outgoing positive control passed. After the incoming repair, the deeper projection exposed another live name-only path: `expandImportedFileCalls` could add a region-level candidate even after `expandCompilerFileRelations` had resolved the invocation. This fallback is now restricted to files without usable compiler occurrence evidence and retains its actual source owner. An outgoing negative test covers the same false-binding cases so the old heuristic cannot reintroduce them through a different direction.

The wider fixture also demonstrated that local member callers cannot depend on the cross-file caller map's name-based fallback. Incoming discovery now explicitly checks the defining file. Compiler call targets retain their parsed lexical owners and share `lexicalCallOwners` with the existing call-graph implementation, so same-line declarations do not collapse into one guessed owner. Per-file call resolution is memoized for one topology traversal.

The Unicode case exposed a producer defect: pinned scip-typescript 0.4.0 emits UTF-16 columns (`Range.fromNode` uses TypeScript's `getLineAndCharacterOfPosition`) but its older generated Document serializer has no position-encoding field. Real SQLite documents consequently had null encoding, and the conservative range decoder correctly refused non-ASCII column guesses. The shared document runtime now extends that serializer to declare SCIP field 6 as UTF-16 for both standalone fragments and full-index nested documents. Producer contract 3 and document adapter 5 invalidate older reusable generations. This is a deliberate producer migration; no query-side encoding guess is introduced.

A separate outgoing regression confirmed that a selected unused function could acquire its same-line neighbor's exact call through file-range expansion. Compiler targets now carry their lexical owner into that expansion too. The shared owner resolver is reused in both directions; selecting the unused function alone must report no calls, and selecting it alongside its neighbor must attribute the call only to the neighbor.

- [x] Preserve exact compiler occurrence identity and invocation position when constructing incoming calls; do not replace binding identity with matching names.
- [x] Share call-target resolution between incoming and outgoing projections so both directions agree about a supported direct call.
- [x] Preserve all direct import, renamed re-export, and namespace callers when several spellings occur in one file.
- [x] Reject false imported-target associations when a parameter or local declaration hides that import.
- [x] Keep compiler-unresolved invocations out of exact call claims, retain candidate strength for the legacy source fallback, and verify complete recovery of output-budget omissions. General indirect-call/provider limits remain disclosed limitations, not a claim of whole-program completeness.
- [x] Add public-CLI regression fixtures with independently specified caller sets, direction consistency, and declaration-shadowing counterexamples. Test depth and budget changes without turning legitimate indirect-call limitations into exact claims.
- [x] Run the relevant graph/exploration suites and the repository's required validation after implementing the repair.

## Validation results

- The original public-CLI regression failed four checks before the repair; the added same-line outgoing counterexample also failed before its owner fix.
- All 73 focused graph checks pass, including 10 public-CLI cases using a real compiler index. The wider targeted run also passed serialization, fragment-store, shared-generation, migration, and occurrence-contract assertions. One earlier run exceeded the default five-second test timeout on cold CLI preparation; this subprocess integration suite now uses an explicit 60-second timeout, matching its bounded subprocess operations.
- Final lint, build, public API validation (66 paths), and type checking passed. Logs: `/tmp/scip-query-incoming-lint-final.log` and `/tmp/scip-query-incoming-types-final.log`.
- The repository's own three-language index rebuilt successfully under producer contract 3 in 16.4 seconds; the final source refresh also passed in 19.4 seconds (`/tmp/scip-query-incoming-final-index.log`).
- Source review covered 574/574 eligible files, with no missing/ambiguous internal imports, all 56 dependency-rule rows declared, and no group cycles. The introduced complexity finding was resolved by keeping each call's evidence method and strength together and removing the redundant callsite boolean; final scoped review reports no findings.
- Final whole-source review reports no findings (`/tmp/scip-query-incoming-final-review.log`). Configured architecture checks passed over 589 indexed files and 56 boundaries, retaining the report's test-fixture/import coverage limitations (`/tmp/scip-query-incoming-architecture.log`).
- Fresh diff impact identified 33 changed symbols and 15 consumer files. It disclosed 11 excluded/unindexed changed paths and seven changed line ranges without indexed owners; current-source review covers the production edits separately (`/tmp/scip-query-incoming-diff-impact.log`). The temporary local watcher used for this check was stopped afterward.
- The first full run passed 3,444 tests and failed one existing anonymous-index history test during watcher shutdown: a PID remained observable after the forced-stop timeout. The process was gone when inspected, and that test passed in isolation (`/tmp/scip-query-incoming-cleanup-recheck.log`). The second complete run against the final rebuilt package passed all 3,445 tests across 399 files in 279.72 seconds (`/tmp/scip-query-incoming-full-tests-final.log`). The initial cleanup failure did not recur; no watcher code or cleanup assertion was weakened.

Existing TypeScript indexes require one rebuild to adopt producer contract 3. The compatibility checks reject reusable generations and fragments from older contracts. This repair establishes the tested compiler-resolved direct calls and their source owners; arbitrary indirect calls and dynamic dispatch still require the packet's coverage qualifications and, where necessary, source confirmation.

VM installation was completed in the subsequent authorized follow-up documented above. That follow-up also identified remaining source-owner/control-analysis and superclass-constructor gaps outside the direct-call cases repaired here.
