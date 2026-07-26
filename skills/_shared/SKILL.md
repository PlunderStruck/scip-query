---
name: _shared
description: Load only as reference material from within another scip-* workflow skill when that skill's own shortlist is insufficient — never invoke _shared directly as the owning workflow for a task.
disable-model-invocation: true
---

## Purpose

`_shared` is the catalog every other scip-* skill draws its command vocabulary and correctness rules from: freshness/lookup mechanics, the full command-family list, detector precision tiers, postcheck rules, the event ledger, and the subagent evidence-boundary contract. It is not a workflow — no task should end with "I invoked `_shared`". Come here mid-task from another skill when that skill's own shortlist runs out.

A SCIP index is the compiler-derived map of a repository: source files, symbols, references, imports, calls, dependencies. It differs from text search because it records what the language toolchain actually resolved, so a claim backed by it can name definitions and consumers rather than matching strings. A **graph fact** is anything produced from that index — a definition line, a reference site, a caller, a dependency, a reverse dependency, an affected consumer.

**Match evidence to the claim.** Native search and file reads are valid for literal text, exact local source, and unambiguous local logic (e.g. a helper defined two lines down in the same file is not a resolution claim). Use scip-query whenever the claim depends on compiler-resolved identity or on a relationship set being complete — definitions, references, callers, dependencies, consumers, affected units, public surface. Many scip-query commands return a bounded/capped sample rather than an exhaustive set; say so explicitly rather than treating a bounded result as proof of completeness.

## Triage table

| Need | Where |
|---|---|
| Full command vocabulary (every command this repo's CLI exposes, owned or not) | `references/command-catalog.md` |
| Detector precision tiers, diff-gate's ten checks, root-cause groups, event ledger, effectiveness | `references/detector-precision-and-diffgate.md` |
| Subagent evidence-boundary contract, dead-code reference-counting status and residual gap | `references/evidence-and-dead-code.md` |
| The edit-to-postcheck table (which postcheck to run after which kind of edit) | `scip-verify` skill — authoritative, do not duplicate it here |

## Freshness gate

Before trusting any graph fact: run `scip-query status --capabilities`. If freshness reports `fresh`, continue. If it reports `stale`, `missing`, or `unknown`, run `scip-query reindex` first — it indexes the codebase and converts it to SQLite — then re-check status before proceeding.

## Symbol lookup fallback ladder

Look symbols up by partial name, no parentheses: `scip-query code parseConfig`, `scip-query trace loadSettings`. If a lookup is ambiguous or comes back empty:
1. Retry with a shorter symbol name.
2. If still unresolved, run `scip-query outline <file>` to get a tree of that file's symbols with line ranges.
3. If outline doesn't resolve it, run `scip-query trace <name>` (definition plus every reference).
4. Last resort, once you already know the file and line range: `scip-query code 'path/to/file.ts:START-END'`.

`scip-query files <pattern>` is the step before step 1 when you have a name fragment but no path — feed its result into outline or the lookup ladder. `scip-query stats` gives index statistics; reach for it when validating that a reindex actually populated the index (e.g. during setup/calibration, not mid-exploration).

## Reading a symbol once located

- `scip-query members <symbol>` — every child of a symbol (methods, fields, nested types). Use once `hierarchy` or `by-kind` has identified a class/type, to see its full surface before editing or removing it.
- `scip-query hierarchy <symbol>` — a method's ancestry chain up to its class and module. Use before editing a method, to understand the containing type's contract.
- `scip-query by-kind <kind>` — every symbol of a SCIP kind (class, interface, enum, function…). Use after `scip-query kind-counts` (a histogram of kinds in the codebase) narrows down which kind is worth a systematic sweep.
- `scip-query refs <symbol>` — every file referencing a symbol. This is the strong-signal confirmation step: whenever a dead-code or "is this used" claim needs checking, run `refs` before asserting it.

## Structural surveys before a change

- `scip-query system <module>` — full module map (files, symbols, deps in/out). Use to onboard to an unfamiliar module or produce a module-level briefing.
- `scip-query surface <module>` — the symbols consumers actually use from a module. Compare against its declared exports to see whether public API can be pruned.
- `scip-query imports <file>` — what a file imports. Use to audit a file's dependency footprint before moving or refactoring it.
- `scip-query deps <file>` — internal files this file depends on (upstream blast radius).
- `scip-query rdeps <file>` — files that depend on this file/module (downstream blast radius: who breaks if it changes).

## Deeper semantics

- `scip-query dataflow <symbol>` — reference-level dataflow: definition sites, usage sites, producers, consumers. Use when debugging or planning a change and location alone (`refs`) isn't enough — you need to know how data moves through the symbol.
- `scip-query slice <symbol>` — a reference-level program slice, backward (what affects this symbol) or forward (what this symbol affects). Use to scope the minimum code touched by a targeted refactor.

## Dead code and duplication

- `scip-query dead [scope]` — repository-dead code, file-internal symbols, implicit-usage signals. Cross-check any hit with `refs` before deleting; see `references/evidence-and-dead-code.md` for the one residual false-dead gap (ambiguous leaf name reached only through a re-exporting barrel in a workspace package).
- `scip-query isolated` — completely orphaned symbols with no references at all; the stricter sibling of `dead`, same reference-counting layer, same residual gap caveat.
- `scip-query similar [symbol] [other]` — heuristic function-similarity candidates from callee fingerprints. Good-with-review signal: read the code before treating a hit as a real duplicate.
- `scip-query similar-files [file]` — heuristic similar-file candidates from dependency profiles. Use before writing a new file, to check whether a sibling already does the job; review before acting.

## Coupling and architecture health

- `scip-query fan-in [symbol]` — how many files reference an exact symbol. Use to gauge a symbol's criticality/blast-radius before changing its signature.
- `scip-query fan-out [file]` — how many external symbols a file uses (or the top-fan-out list across the codebase). Use to gauge a file's coupling debt before deciding whether to split it.
- `scip-query coupling [file1] [file2]` — coupling between two named files, or the top coupled pairs codebase-wide. Use when a specific pair is suspected of hidden coupling, or when scanning for the worst offenders.
- `scip-query cycles` — circular dependency chains between files. Use when investigating why files resist clean layering or isolated testing.
- `scip-query bottlenecks` — symbols/files with high fan-in *and* high fan-out (coupling hubs). Use to prioritize a maintainability review.
- `scip-query architecture` — evaluates project-owned architectural boundaries and dependency rules. Its baseline is what diff-gate's `architecture` check reads from directly (see `references/detector-precision-and-diffgate.md`).

## History

- `scip-query co-change [file]` — files that change together in git history without a dependency edge: hidden-coupling candidates the graph misses. Good-with-review signal. Use before splitting a file to check whether its historical co-change partner also needs updating.

## Governance: config, suppression, effectiveness

1. `scip-query init` — creates `.scipquery.json` for a project. Run once, at bootstrap, before any config-dependent command.
2. `scip-query config-validate` — validates `.scipquery.json`, including structured suppressions and declared coupling groups. Run after hand-editing either.
3. `scip-query suppress <id>` — records an accepted finding as a file under `.scipquery/suppressions/` with a required reason, the moment you decide a finding is a false positive or an accepted risk. This is what feeds the "suppressed" count in effectiveness.
4. `scip-query effectiveness [--since 30d] [--check <check>] [--json]` — per-check history from the committed outcome ledger: findings caught, comparison-verified fixed, suppressed, still open, "moved" (rename noise), legacy/non-comparable "unverified" resolutions, precision (verified-fixed ÷ (verified-fixed + suppressed)), and median days-to-fix. Run this periodically, or the moment diff-gate feels noisy, to see which checks are earning their keep — then either tune that check's config, suppress the standing findings with reasons, or consciously accept the noise. Do not let unresolved findings accumulate as wallpaper.

Standalone detector commands (outside diff-gate) are not outcome-tracked in this ledger until they expose complete-scan evidence. A pre-commit rerun of diff-gate reuses the same comparison base directly; after HEAD advances, a clean diff-gate run automatically replays the stored comparison commit. A dirty or unavailable replay leaves the effectiveness finding pending rather than manufacturing a fix result.

## Postcheck

Every implemented change ends with `scip-query status --capabilities` and `scip-query diff-gate --json`. Fix each finding, or record a specific acceptance reason for each one left unresolved (findings marked `(advisory)` never block — treat them as context, not obligations). Do not report success while a diff-gate finding is unexplained. The authoritative table of *which* postcheck to run for *which* kind of edit lives in `scip-verify`; invoke that skill rather than re-deriving it here.

## Subagent evidence boundary

When a subagent gathers scip-query evidence, its prompt must carry these rules verbatim:
- Use scip-query for any compiler-resolved-identity or completeness claim; native search/file reads are valid only for literal source content and unambiguous local logic (e.g. a helper defined in the same file).
- The trigger is resolution or completeness, not whether execution crosses a call boundary: asserting what `handler(x)` does without resolving what `handler` is requires scip-query evidence; reading a helper defined two lines down in the same file does not.
- Cite the evidence source appropriate to each claim, and state plainly when neither source establishes a claim completely.

Reject a subagent's finding if it sources a resolution or completeness claim from text search alone. Do not reject a literal-content claim merely for citing a file read as its evidence.
