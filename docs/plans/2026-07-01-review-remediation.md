# Review Remediation Plan — full program

Date: 2026-07-01
Executor: Codex (implementation) → Claude (review pass per phase)
Inputs: [Critical review](../reviews/2026-07-01-critical-review.md) · [TLA redesign proposal](../reviews/2026-07-01-tla-redesign-proposal.md)

Evidence provenance note: this plan is anchored on the 2026-07-01 review, whose claims were produced by live CLI runs on this repo (`refs`, `diff-impact --json`, `diff-gate`, `tla verify` mutation tests, `health`, `similar`, `recent-duplicates`) and audited source reads with file:line citations. `scip-query status --capabilities` reported `fresh` at plan time. Line anchors below are from those audits; **executor must re-verify each anchor before editing (±5 lines drift is expected; larger drift = stop and re-locate by symbol name).**

## Working agreement (read first, applies to every step)

1. Work directly on `main` (repo convention, AGENTS.md). One commit per step, message `remediation <step-id>: <imperative summary>`.
2. Gates per phase before moving on: `npm run typecheck && npm run lint && npm test`, then `scip-query reindex && scip-query diff-gate --json`. Fix findings or record acceptance in the phase's commit message.
3. When a step changes any command descriptor (flags, description, new command): regenerate the reference with `npm run docs:commands` and commit the regenerated `docs/COMMAND_REFERENCE.md` in the same commit. New CLI commands must mirror the full registration pattern of an existing command (descriptor in `src/runtime/commands/command-descriptors.ts` or the relevant `query-command-specs`/`query-commands/*.ts` module, handler, docs group, and a CLI contract test — find the pattern by grepping how `similar-signatures` is registered end to end).
4. Tests are written in the same step as the behavior change, in `tests/` mirroring existing structure. Behavior first testable through a pure core; spawn/fs/git access injected. No snapshot tests.
5. Public API discipline: any new/renamed export under `src/queries/` requires the matching `package.json` `exports` subpath and an API.md row; `tests/` has a contract test for exports parity — keep it green.
6. If source contradicts this plan at any anchor, do not improvise: leave the step unchecked, add a `BLOCKED(<step-id>): <what differs>` note at the bottom of this file, and continue with independent steps.
7. Do not start Phases 9–10 (TLA P1/P2) without explicit go-ahead; everything else is pre-approved.

## Goal

Make the tool's behavior match its stated epistemics: no silent wrong answers (ambiguity, no-match, initializer edits, fake COMPILER-VERIFIED), one architectural labeling path for evidence tiers, consent-respecting install/hooks, truthful docs, a consolidated skill set, and a TLA verifier whose PASS means something. Done = every step's validation command passes, the full gate suite passes, and the six README false claims are gone.

## Current State (condensed; full detail in the review)

- Symbol resolution: `findFirstSymbolMatch` (src/symbols/symbol-lookup.ts:41-58) silently returns 1 of N matches; scorer prefers shortest body (:329). `refs` output discloses nothing (src/runtime/query-commands/navigation.ts:91-94). No-match: `trace` exits 0 with empty sections; `plan-context` prints a bare one-liner.
- Diff attribution: `definitionTouchesChangedRange` (src/queries/impact/diff-impact.ts:535-543) intersects hunks with index def ranges; multi-line initializers index as 1-line (live repro: `BUILTIN_SKILLS` edit → 0 changed symbols, gate PASS).
- Cleanup verify: `runChecker` computes `ok` (src/runtime/cleanup-verify.ts:441-461); `verifyCleanupPlan` (:74-93) never reads it; failure detection = `/\berror\b/i` line diff; banner "COMPILER-VERIFIED" (src/runtime/query-commands/cleanup/handlers.ts:584); worktree = `git worktree add HEAD` (:69) with only plan-file dirtiness disclosed (:262-277).
- Labeling: runtime disclaimer only via `renderHeuristicNotice` (src/runtime/cli-support.ts:71-72) through `heuristicLabel` (src/runtime/commands/command-execution.ts:276); `descriptor.heuristic` feeds docs only (src/runtime/commands/command-docs.ts:23). recent-duplicates/doc-drift/co-change/incomplete-migration/diff-gate emit no runtime disclaimer; recent-duplicates/unused-params/similar-signatures/dead/isolated `--json` has no tier field. "Safe to delete" at handlers.ts:85, health-report.ts:310; "safe to drop" at handlers.ts:754.
- Hooks/install: postinstall (package.json:299 → src/runtime/setup.ts:122-144) symlinks into `$HOME` and can run brew/go installs (src/runtime/scip-cli.ts:164-212); URL constant mismatch (scip-cli.ts:9 `scip-code` vs :175,194 `sourcegraph`). Hooks written to tracked `.claude/settings.json` (src/runtime/agent-hooks.ts:128-135); UserPromptSubmit fingerprints the whole repo per prompt and reindexes synchronously without `skipAutoInstall` (:396-454; src/reindex/index.ts:453-466, 581-582); keyword router (:485-540) substring-matches with multi-route false positives and no off switch; Stop hook default emits only `systemMessage` (:384-386).
- Docs: six false claims (README:152, 167, 250-252 + scip-cli URL; see Phase 6). Health dossier writes absolute paths + timestamps into `docs/` (src/runtime/health-dossier.ts:51-52,76).
- Skills: adoption/setup duplicate pair (router route table skills/scip-query/SKILL.md:36); audit/improve trigger collision; double-gating in router loop/debug/api-impact/triage; concrete-plan's no-op `diff-impact` step (:147-153); `_shared` hand-written catalog (:48-143); nine dead links in .agents/skills/typescript/AGENTS.md.
- TLA: mapping `reads` parsed (src/tla/model-contract.ts:241-245) but never verified; `invariants` never consulted; variable referents may be types (dogfood maps all 5 to interfaces); per-action `allowUnknown` silences the only strong check; referent resolution uses `findFirstSymbolMatch` (src/tla/conformance.ts:534-542); PASS banner overclaims (src/runtime/query-commands/tla.ts:165-167). Verified by mutation tests (review §2).

## Reuse Audit

- Ambiguity: extend `symbol-lookup.ts` — it already collects candidate sets internally; **no new lookup module**. New exported shape `SymbolResolution { match, candidates, total }` lives beside `SymbolMatch` in src/domain/types.ts.
- Diff attribution: reuse the existing AST layer (`getAst` in src/source/ast.ts, already used by conformance.ts) — **no new parser**.
- Rename-aware ages: reuse `detectRenamedFiles` (src/queries/impact/diff-impact.ts:354) / git `--follow` in src/analysis/git-history.ts — **no new rename detector**.
- Tier labeling: extend the existing descriptor field + `printJsonEnvelope` (src/runtime/commands/command-execution.ts) — **no new formatting framework**.
- Small-body duplicates: new detector module is justified — no existing detector hashes normalized bodies (similar = callee fingerprints, similar-signatures = type shapes; verified in review §1.4). Lives in src/queries/cleanup/, registered like similar-signatures.
- `uninstall` command: new, justified — no removal path exists anywhere in src/runtime/ (setup agent audit).
- TLA scaffold/instrument (Phases 9–10): new modules justified per the redesign proposal §3; reuse dataflow/call-graph/write-scan machinery already in src/tla/conformance.ts and src/queries/.
- Everything else is edits to existing units.

## Testability Design

| Behavior | Test seam | Injected deps | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Ambiguity resolution | `resolveSymbol(db, query)` unit tests on fixture DB | fixture SQLite db | candidate ranking + disambiguation decision | none (read-only db) | `SymbolResolution {match, candidates[], total}` |
| Diff attribution | `attributeRangesToDefinitions(defs, ranges, astRanges)` | none | range-widening + intersection | `getAst` wrapper | widened `{symbolId, startLine, endLine}` |
| Verify outcome | `decideBatchStatus(checkerResult, baselineErrors, batchErrors)` | none | status decision (reads `ok`) | `runChecker` spawn wrapper | `'verified'\|'failed'\|'unavailable'` |
| Tier labeling | `findingEnvelope(descriptor, result)` | none | tier stamping | stdout writer | JSON always has `evidence` |
| Hook refresh policy | `shouldRefresh(staleSignal, event, config)` | clock, fs-stat fn | policy decision | reindex invoker | `{refresh: boolean, mode:'background'\|'skip'}` |
| Router | `routesForPrompt(prompt)` | none | word-boundary matcher, max-1 route | hook stdout | `Route \| null` |
| Suppression IDs | `findingId(check, symbol, file)` | none | hash | none | stable across unrelated matches; legacy fallback |
| TLA conformance | `verifyTlaConformance(db, contract, …)` (existing seam) | fixture db | reads/writes comparison, referent-kind check | fs read | findings with per-fact waiver accounting |

---

## Design Phases

Effort key: S = < half day, M = 1–2 days, L = multi-day. Every phase is independently shippable unless noted.

### Phase 1 — Evidence integrity core

#### 1.1 - Disclose ambiguous symbol resolution everywhere

- [ ] **File**: `src/symbols/symbol-lookup.ts:41-58` (+ callers), `src/domain/types.ts`
- **Source**: evidence audit read of symbol-lookup.ts; live run `refs escapeRegex` (7 defs, 1 answered, no disclosure).
- **What**: `findFirstSymbolMatch` chains exact → file:line → path → fuzzy, returns a single `SymbolMatch`, discards the candidate set; ties resolved by SQL row order; fuzzy scorer prefers shortest body (:329).
- **Change**: Add `resolveSymbol(db, query): SymbolResolution` returning `{ match, candidates, total }` where `candidates` = up to 5 other definitions sharing the resolution tier (leaf name / fuzzy pool), each `{shortName, relativePath, startLine}`. Keep `findFirstSymbolMatch` as a thin wrapper (`resolveSymbol(...).match`) so ~all existing callers compile unchanged. Then update the user-facing commands — `refs`, `trace`, `plan-context`, `code`, `call-graph`, `dataflow`, `slice`, `members`, `hierarchy`, `complexity`, `affected` (grep callers of `findFirstSymbolMatch`/its wrappers under src/runtime/query-commands/ and src/queries/) — to:
  - human mode: when `total > 1`, print one header line: `Resolved: <shortName> (<path>) — N other definitions share this name; qualify as <dir/leaf> to target another.` listing the top 3 alternates.
  - JSON mode: add `"resolved": {symbol, shortName, relativePath}` and `"otherMatches": [{shortName, relativePath, startLine}]` + `"totalMatches": N` to the envelope's result object.
- **Testability**: seam = `resolveSymbol` on the existing fixture DB used by symbol-lookup tests; pure core = ranking/candidate collection; contract = `SymbolResolution`. CLI-level: extend the existing refs/trace contract tests to assert the disclosure line and JSON fields on a fixture with a duplicated leaf name.
- **Validation**: `node dist/cli.js refs escapeRegex` prints the disclosure header naming 6 others; `refs impact/escapeRegex` targets the qualified one with `totalMatches: 1`. New unit tests pass.
- **Why**: Root of the evidence-integrity failures; must land before 7.x (TLA reuses it) and 1.2.

#### 1.2 - Make no-match and near-miss explicit

- [ ] **File**: same command handlers as 1.1; `src/symbols/symbol-lookup.ts`
- **Source**: live runs `trace definitelyNotARealSymbolXyz` (exit 0, empty sections), `plan-context runDiffGate` (bare one-liner).
- **What**: No-match renders empty sections (trace) or a one-line shrug (plan-context); exit 0; no suggestions.
- **Change**: When resolution yields no match: (a) human mode prints `No definition matched '<query>'.` plus up to 5 nearest names by leaf-name trigram/levenshtein over the definitions table (pure function `nearestSymbolNames(db, query, n)` in symbol-lookup.ts — reuse the existing fuzzy scorer's normalization); (b) JSON emits `"matched": false, "suggestions": [...]` in the result; (c) exit code stays 0 (agents branch on `matched`, scripts on stdout) **except** `refs`/`trace`, which gain nothing from empty success — keep exit 0 but never render empty section headers.
- **Testability**: pure `nearestSymbolNames` unit-tested on fixture db (typo cases: `runDiffGate`→`diffGate`).
- **Validation**: `node dist/cli.js plan-context runDiffGate` suggests `diffGate`; `trace zzz --json` has `matched:false`.
- **Why**: Silent empties are indistinguishable from "exists, unreferenced" — the second half of the 1.1 poison.

#### 1.3 - cleanup-verify must respect checker exit status

- [ ] **File**: `src/runtime/cleanup-verify.ts:74-93, 441-461`
- **Source**: evidence audit; `ok` computed at :441-461, unread at :74-93.
- **What**: Batch failure detected only by new `/\berror\b/i` lines vs baseline; `go build` and ruff failures without that literal word verify falsely; identical-text errors are baseline-masked (:127-129 strips positions).
- **Change**: Extract pure `decideBatchStatus(checker: {ok, exitCode}, baselineErrors: string[], batchErrors: string[]): 'verified'|'failed'` with rules: `ok === false && newErrors.length === 0` → `'failed'` with reason `checker exited <code> with unparsed output`; nonzero exit always ≥ failed. Keep differential masking for parsed errors but key on `text + count` (an *additional* identical-text error in the same file is new). Surface the raw checker tail (last 10 lines) in the failure finding.
- **Testability**: seam = `decideBatchStatus` (pure, no spawn); table-driven tests: go-build-style output, ruff "Found 2 errors.", clean pass, baseline-masked, count-increase case. Plus one e2e test in tests/runtime/ that runs `verifyCleanupPlan` against a tiny fixture repo with an injected fake checker (`spawn` already injectable via `CommandAvailabilitySpawn` pattern — mirror tool-runner.ts:40).
- **Validation**: new tests; manual: point a fixture checker that exits 1 printing `undefined: foo` — batch reports `failed`, `cleanup-apply --verified` refuses.
- **Why**: "COMPILER-VERIFIED" gates real deletions; currently falsifiable. Independent of everything else — do early.

#### 1.4 - Rename the verification banner per oracle and disclose worktree scope

- [ ] **File**: `src/runtime/cleanup-verify.ts:69, 144-184, 262-277`; `src/runtime/query-commands/cleanup/handlers.ts:561, 584`
- **Source**: evidence audit (checker table :144-184; clj-kondo is a linter; worktree at HEAD; dirtyOverlap plan-files-only).
- **What**: One banner "COMPILER-VERIFIED" regardless of oracle; verification runs at HEAD; untracked/dirty non-plan source invisible; "need tsconfig.json or a Cargo.toml" under-describes the 5-oracle list.
- **Change**: (a) Banner becomes `VERIFIED (<oracle>)` where oracle ∈ `tsc|go build|ruff|python-compileall|clj-kondo|cargo check`; when oracle is a linter/syntax-only checker append `— lint-level check, not a type proof`. (b) Before verification, run `git status --porcelain`; if any dirty/untracked file (not just plan files) exists, add a disclosed warning finding `verification ran at HEAD; N working-tree change(s) were not compiled` (list up to 5 paths). (c) Fix the :561 message to enumerate the actual oracle detection list.
- **Testability**: banner/warning strings from pure formatters; extend 1.3's e2e fixture with an untracked file.
- **Validation**: run `cleanup-plan --verify` on this repo with an untracked scratch file → warning appears.
- **Why**: Keeps tier-4's "the only tier that earns 'safe'" honest without blocking the workflow.

#### 1.5 - Attribute initializer-body edits to their enclosing symbol

- [ ] **File**: `src/queries/impact/diff-impact.ts:109-160, 535-547`
- **Source**: live repro (BUILTIN_SKILLS edit → `changedSymbols: []`); `trace BUILTIN_SKILLS` shows index range 8-8 while the initializer spans ~24 lines.
- **What**: Hunk↔definition intersection uses index ranges; scip-typescript records `export const X = [...]` as a 1-line definition, so initializer edits attribute to no symbol and skip every symbol-keyed gate check.
- **Change**: In `diffImpactPartial`, after the existing range filter produces its def set, compute the **unattributed residue**: changed ranges in analyzed files not covered by any candidate def range. For each residue range, widen attribution via AST: `getAst(db, file)` (same helper conformance.ts uses), find the smallest top-level declaration node whose span contains the range, map it back to the index definition whose `startLine` falls inside that node's span, and attribute. Cache one AST per file per run. If AST unavailable (no tree-sitter), fall back to: attribute residue to the nearest preceding definition whose file offset starts ≤ range start (documented as approximate). Emit a new result field `attributionNotes: [{file, lines, method: 'ast-widened'|'nearest-preceding'|'unattributed'}]`; `diff-gate` prints unattributed residues as an info line instead of silence: `note: N changed line-range(s) in <file> belong to no indexed symbol`.
- **Testability**: seam = extract pure `attributeResidue(defs, ranges, declSpans)` (index defs, hunk ranges, AST spans as plain data). Unit tests: 1-line const + multi-line array edit; object literal; edit between two defs; md-file (skipped). E2E: fixture repo where an exported const array gains a line → `diff-impact --json` lists the const with its consumers.
- **Validation**: on this repo, re-add a scratch line inside `BUILTIN_SKILLS`, run `diff-impact --json` → `changedSymbols` includes `BUILTIN_SKILLS` with fanIn ≥ 1; revert.
- **Why**: Closes the review's #2 headline; the gate's marquee scenario (config/schema tables) currently bypasses it.

#### 1.6 - Stabilize suppression IDs (with legacy migration)

- [ ] **File**: `src/queries/impact/diff-gate.ts:404-409, 872-879` (id computation), suppression matching (~:340-363)
- **Source**: evidence audit — id = sha256(check, symbol, file, sorted full match-set).
- **What**: Including the match-set means any new similar function anywhere changes the ID and silently un-suppresses accepted findings.
- **Change**: New id = `SQ` + hash(check, symbol, file) only. **Migration**: when matching suppressions, compute both new and legacy ids and match either; `config-validate` prints an info diagnostic for entries that only match via legacy form, with the replacement id. Matches move to a metadata field on the finding (unchanged output shape otherwise).
- **Testability**: pure id function unit tests; matching test with a legacy-format entry.
- **Validation**: this repo's `.scipquery.json` suppressions still match (run `diff-gate --json`, confirm `suppressed` count unchanged); `config-validate` lists legacy entries.
- **Why**: One-way door if shipped without dual-matching — the dual-match makes it two-way.

#### 1.7 - Rename-aware file ages for recent-duplicates

- [ ] **File**: `src/analysis/git-history.ts:382-390`; `src/queries/cleanup/recent-duplicates.ts:385-428`
- **Source**: evidence audit — age from `git log --diff-filter=A --name-only`, no rename detection; `orientRecentDuplicate` then flips ECHO direction after a `git mv`.
- **What**: A moved established file looks newly added; the *original* gets labeled the echo with a "delete the echo" directive.
- **Change**: Add `--find-renames` to the age extraction (`git log --diff-filter=A -M50% --name-status` and follow the rename chain to the earliest add), or cheaper: post-process with one `git log --follow --format=%H -- <file> | tail -1` for files whose computed age falls inside the recency window (only candidates need the precise age). Cap follow calls at the candidate count (already bounded by `--window`).
- **Testability**: seam = git-history function against a temp fixture repo (the suite already builds real-git fixtures — mirror the co-change tests); case: create file, 3 commits, `git mv`, assert age = original add.
- **Validation**: fixture test; on this repo output unchanged (no recent renames expected).
- **Why**: Wrong *directionality* is worse than no finding — it instructs deleting the original.

#### 1.8 - Disclose analysis-budget degradation in JSON and hook output

- [ ] **File**: `src/runtime/cli-support.ts:87-111`; `src/runtime/query-commands/impact.ts:199-201`
- **Source**: evidence audit — disclosure goes to stderr, suppressed exactly when `quiet: hookMode || json`.
- **What**: Large-index budget caps scans/semantic enrichment silently in the two modes agents consume.
- **Change**: Thread the computed budget into the result payload: diff-gate JSON gains `"analysisBudget": {scanLimit, semanticEnrichment: boolean, reason}` whenever a cap engaged (omit when uncapped); hook mode appends one line to its message. Never write the stderr notice in JSON mode (replaced by the field).
- **Testability**: pure budget computation already isolated; add an envelope test forcing a small budget via injected index-size.
- **Validation**: unit test; `diff-gate --json` on this repo has no `analysisBudget` key (small index).
- **Why**: A reduced-coverage pass that presents as a full pass violates the core promise.

### Phase 2 — One labeling choke point

#### 2.1 - descriptor.heuristic drives runtime output and JSON tier field

- [ ] **File**: `src/runtime/commands/command-execution.ts` (~:276 `heuristicLabel`, `printJsonEnvelope`), `src/runtime/commands/command-docs.ts:23`, descriptors of: recent-duplicates, doc-drift, co-change, incomplete-migration, diff-gate, similar-signatures
- **Source**: evidence audit (two disconnected mechanisms; command gap list).
- **What**: Runtime disclaimer and docs flag are separate; five agent-facing commands emit no disclaimer; five commands' `--json` lacks any tier field; `similar-signatures` flagged by neither.
- **Change**: (a) Single source: give every descriptor an `evidence` field: `'graph-fact' | 'heuristic' | 'mixed'` (replaces the boolean `heuristic`; docs renderer updated). (b) `printJsonEnvelope` stamps top-level `"evidence": <tier>` into every envelope from the descriptor; commands whose findings carry per-item tiers (diff-gate) keep those too. (c) The human-mode pipeline emits `renderHeuristicNotice` automatically for `heuristic|mixed` descriptors, including custom-render commands — thread it through the shared entry all handlers pass (dbCommand/sectionedReportCommand); custom handlers that bypass it get the notice printed by the dispatcher before the handler runs. (d) Set the field on all ~40 descriptors (graph-fact: refs/trace/deps/outline/etc.; heuristic: the cleanup/frontend family; mixed: diff-gate, health, plan-context, co-change).
- **Testability**: one dispatcher-level test: for every registered descriptor with `evidence != 'graph-fact'`, invoking with `--json` yields `evidence`, and human mode's first line matches the notice (walk the registry — this test prevents future gap-commands structurally).
- **Validation**: `recent-duplicates --json | jq .evidence` → `"heuristic"`; human run shows notice.
- **Why**: Converts per-command artisanal honesty into an architectural invariant — the review's central diagnosis.

#### 2.2 - Purge "safe" language outside tier-4

- [ ] **File**: `src/runtime/query-commands/cleanup/handlers.ts:85, 754`; `src/queries/health/health-report.ts:310`; `docs/AGENT_GUIDE.md:191` (+ "Zero risk" table row nearby)
- **Source**: docs + evidence audits.
- **What**: `dead` prints "Zero references anywhere … Safe to delete."; health action says "safe to delete"; unused-params says "safe to drop"; AGENT_GUIDE says "can be safely deleted"/"Zero risk" — all tier-1/3 findings; README:202 reserves "safe" for compiler verification.
- **Change**: Replace with candidate language + escalation pointer: `Deletion candidates — confirm with cleanup-plan --verify before deleting.` unused-params keeps its stronger claim but phrased as designed: `type-safe to remove at the signature; check call sites for side-effectful arguments.` Update AGENT_GUIDE rows to match.
- **Testability**: string assertions in existing handler tests.
- **Validation**: `grep -rn "afe to delete" src/ docs/` → only tier-4 contexts remain.
- **Why**: Cheapest possible alignment of output language with the tool's own doctrine.

#### 2.3 - co-change file-mode labeling

- [ ] **File**: `src/queries/impact/co-change.ts` render path (file-specific mode), descriptor text
- **Source**: live run `co-change package.json` shows `[dep edge]` pairs under a command described "without a dependency edge".
- **What**: File mode intentionally shows all partners (declared couplings/dep edges included) but nothing explains the apparent self-contradiction.
- **Change**: In file mode, print a one-line legend when any shown pair has a dep edge or declared coupling: `note: file mode lists all historical partners; [dep edge]/[declared] pairs are excluded from hidden-coupling findings.` Repo-wide mode unchanged.
- **Validation**: rerun `co-change package.json`, legend present.
- **Why**: Prevents agents reading the tag as a detector bug (this reviewer did, briefly).

#### 2.4 - self-audit: audit the real path, count oracle zeros, disclose coverage

- [ ] **File**: `src/queries/health/self-audit.ts:105, 110, 211`
- **Source**: evidence audit.
- **What**: Samples where the oracle found zero refs are skipped (`continue`), biasing precision up; the audited cheap path (`getResolvedReferenceSites`) is not the production `refs` path (`findReferences`-first, src/queries/navigation/reference-sites.ts:67-71); output prints bare `precision 1.0`.
- **Change**: (a) For the references check, when the oracle is complete (:211), zero-oracle samples count: any cheap-path refs on them are false positives. (b) Audit the same entry production uses (call the reference-sites resolution used by `refs`). (c) Output gains `(N compared, M skipped: oracle-partial)` after each metric line — never a bare 1.0.
- **Testability**: scoring math extracted pure (`scorePairs(cheap, oracle, oracleComplete)`) + unit tests including the zero-oracle case (this math currently has zero tests).
- **Validation**: `self-audit --samples 30` on this repo prints coverage counts; unit tests.
- **Why**: A self-audit that grades a non-default path on a biased sample is worse than none — it manufactures trust.

### Phase 3 — Close the duplicate-detector gap

#### 3.1 - Small-body duplicate detector (`duplicate-bodies`)

- [ ] **File**: new `src/queries/cleanup/duplicate-bodies.ts`; registration per working-agreement #3; wire into `health` hygiene and `diff-gate` echo pre-pass
- **Source**: review §1.4 — `escapeRegex`×7 + `escapeRegExp`×3 invisible to similar (callee fingerprints), recent-duplicates (window), similar-signatures (noise cluster).
- **What**: No detector compares normalized bodies; the tool cannot find byte-identical tiny helpers.
- **Change**: Detector: for every indexed callable ≤ N LOC (default 15, `--max-loc`), normalize body text (strip comments/whitespace via the existing source-stripper; **do not** rename identifiers in v1), hash, group by hash, report groups ≥ 2 spanning ≥ 2 files with the canonical member (oldest by git age — reuse 1.7's helper) first. Output shape mirrors `similar` (evidence: heuristic; recommendation: consolidate into the established copy). Health: count groups as hygiene pressure (one deduction line, capped like other hygiene items). diff-gate echo check: before the fingerprint similarity pass, hash-match new/changed small callables against established ones — an exact-body match is a free, high-confidence echo finding.
- **Testability**: pure `normalizeBody(text)` + `groupByHash(entries)`; fixture with two identical helpers + one near-miss (must NOT match — exactness is the v1 contract). CLI contract test.
- **Validation**: `node dist/cli.js duplicate-bodies` on this repo reports the escapeRegex family (≥ 2 groups); `health` hygiene drops accordingly; gates in working-agreement #2 pass with the new findings either fixed (consolidate this repo's own escapeRegex into one exported helper — do it as part of this step, it's the proof) or suppressed with reasons.
- **Why**: The tool's #1 marketed failure mode must be detectable in its own repo; consolidating the real duplicates dogfoods the fix.

#### 3.2 - similar-signatures size banding

- [ ] **File**: `src/queries/cleanup/similar-signatures.ts` (clustering)
- **Source**: live run — `(string)→string` cluster mixed 3-LOC and 56-LOC functions.
- **What**: Shape-only clustering drowns signal for ubiquitous shapes.
- **Change**: Within a shape cluster, sub-group by LOC band (≤5, 6-20, >20) and suppress clusters whose shape occurs > K times repo-wide (default 12, `--max-shape-frequency`) unless bodies also hash-match (3.1's helper) — those always show.
- **Validation**: rerun on this repo: escapeRegex family still reported; formatScipName/truncateAtImplementationStart no longer share a group.
- **Why**: Keeps 3.1's complement useful instead of noisy.

### Phase 4 — Consent, install, hooks

#### 4.1 - Defang postinstall

- [ ] **File**: `package.json:299`, postinstall source (`src/runtime/postinstall.ts` or as found), `src/runtime/setup.ts:122-144`
- **Source**: setup audit.
- **What**: Every npm install symlinks into `$HOME` (3 roots) and may run `brew install`/`go install …@latest` with failures swallowed by `|| true`.
- **Change**: postinstall prints exactly one line (`scip-query installed — run 'scip-query setup' in a repo to enable skills, hooks, and the index.`) and does nothing else. All home-dir writes and toolchain installs move behind explicit `setup`/`install-skills`/`check-deps --install`. Toolchain auto-install prompts (TTY) or requires `--install` (non-TTY); never `@latest`-unpinned without saying so.
- **Testability**: postinstall becomes a trivially testable pure printer; setup path already covered by setup tests — update expectations.
- **Validation**: `npm pack && npm i -g ./scip-query-*.tgz` in a scratch prefix: no `$HOME` writes (diff `~/.claude/skills` before/after).
- **Why**: Consent. **One-way door** (new installs stop self-wiring) — release-note it.

#### 4.2 - Fix the scip release URL constant

- [ ] **File**: `src/runtime/scip-cli.ts:9` (uses at :125, :151)
- **Source**: setup audit — `scip-code/scip` vs `sourcegraph/scip` at :175/:194.
- **Change**: Single constant `https://github.com/sourcegraph/scip`; grep for other `scip-code` occurrences repo-wide and fix.
- **Validation**: `grep -rn "scip-code" src/ docs/` → 0 hits.
- **Why**: The printed manual-download URL is a potential binary-planting vector. Do first in the phase; it's one line.

#### 4.3 - Hook refresh policy: never heavy work on the prompt path

- [ ] **File**: `src/runtime/agent-hooks.ts:396-454, 430, 461`; `src/reindex/index-freshness.ts:107`; callers in `src/reindex/index.ts:453-466, 581-582`
- **Source**: setup audit; live session evidence (auto-reindex on session start and on this plan's own prompt).
- **What**: UserPromptSubmit hashes every tracked+untracked file per prompt; stale → synchronous reindex without `skipAutoInstall` (can run brew/go/npm-g); SessionStart fingerprints twice.
- **Change**: (a) Cheap staleness first: compare `git status --porcelain` + newest mtime under tracked roots against the index's recorded stamp; only when the cheap signal says stale is the full fingerprint computed — and only on SessionStart. (b) UserPromptSubmit **never** reindexes: if stale, inject one line `index is stale; evidence commands will note staleness — run scip-query reindex` and continue. (c) SessionStart may refresh but in a **detached background** process (`spawn` detached + unref; write outcome to meta.json for the next status call) and always passes `skipAutoInstall: true`. (d) Deduplicate the double fingerprint (:430/:461). (e) Toolchain auto-install is never reachable from any hook path (assert with a test).
- **Testability**: seam = pure `shouldRefresh(event, cheapSignal, config)`; injected clock/fs-stat. Background spawn isolated in a shell wrapper with an injected spawn fn.
- **Validation**: unit tests; manual: touch a file, submit a prompt → response context contains the one-liner, no reindex process spawned (check meta.json untouched).
- **Why**: Removes the worst per-prompt cost and the chat-message→package-manager path (review headline #7).

#### 4.4 - Hooks target settings.local.json; pin the command; add opt-outs

- [ ] **File**: `src/runtime/agent-hooks.ts:128-135, 307, 320, 332`; `src/runtime/project-setup.ts:243-263`
- **Source**: setup audit.
- **What**: Hooks land in tracked `.claude/settings.json` with a bare PATH-resolved `scip-query`; no `--no-hooks`; re-setup re-adds removed hooks.
- **Change**: (a) Default target `.claude/settings.local.json`; `setup-hooks --shared` opts into the tracked file with a printed warning about teammates. (b) Command string: prefer repo-local `node_modules/.bin/scip-query` when present, else `scip-query` (document the fallback). (c) `setup --no-hooks` flag joins the env var. (d) Record removed-by-user: when pruning managed hooks finds the marker absent but a tombstone (`"scipQueryHooks": "declined"`) present in the settings file, skip re-adding; `setup-hooks --force` overrides; write the tombstone when the user removes via a new `setup-hooks --remove`.
- **Testability**: hook merge already tested — extend fixtures for local-file default, tombstone, `--remove`.
- **Validation**: fresh fixture repo: `setup` writes only settings.local.json; `setup-hooks --remove && setup` does not re-add.
- **Why**: Checked-in PATH-resolved exec-on-open is the trust problem; migration path: existing tracked entries are pruned by `--remove` and re-created locally.

#### 4.5 - Router: word-boundary, single route, off switch; Stop hook defaults to feedback

- [ ] **File**: `src/runtime/agent-hooks.ts:485-540 (router), 176-185 (mode parse), 347-386 (stop)`
- **Source**: setup audit + live triple-route on this session's first prompt.
- **What**: Substring keyword soup, up to 7 simultaneous routes, no off switch; Stop default emits `systemMessage` only (model never sees it); `MODE=1/true` selects `block`.
- **Change**: (a) Extract pure `routesForPrompt(prompt): Route | null` — word-boundary regex per keyword, category priority order (explicit skill mention > setup > debug > review > …), return at most one; return null when < 2 keyword hits to cut drive-by matches. (b) Config: `hooks.router: "off" | "single" (default)` in `.scipquery.json` (validated in config schema); env `SCIP_QUERY_ROUTER=off` override. (c) Stop hook default mode `feedback` (`hookSpecificOutput.additionalContext`) so findings reach the model; `warn` remains selectable; truthy-but-unknown env values mean `feedback`, not `block`. (d) Stop hook prepends `gate ran against a stale index` when 4.3's cheap signal says stale.
- **Testability**: `routesForPrompt` table-driven tests including this session's prompt text (must yield exactly one route or null); mode-parse tests.
- **Validation**: unit tests; manual prompt "review this tool" injects ≤ 1 route.
- **Why**: The router currently burns tokens to misroute; the Stop default burns latency to inform nobody.

#### 4.6 - `uninstall` command

- [ ] **File**: new command (registration per working-agreement #3), reusing setup.ts's root/skill enumeration
- **Source**: setup audit — no removal path exists.
- **Change**: `scip-query uninstall [--global|--project]`: global removes the package's symlinks from the three skill roots (only links resolving into a scip-query package — never user dirs); project removes managed hook blocks (via 4.4's `--remove` internals), the AGENTS.md/CLAUDE.md managed block, and prints what it left (config, dossier). `--dry-run` lists actions.
- **Testability**: fs operations behind the existing install helpers; fixture-home tests both directions (install → uninstall → clean diff).
- **Validation**: fixture round-trip test.
- **Why**: Symlink lifecycle (npx cache pruning, last-install-wins) currently has no exit.

#### 4.7 - Health dossier: relative paths, no timestamp churn, optional location

- [ ] **File**: `src/runtime/health-dossier.ts:51-52, 76`; `src/runtime/project-setup.ts:325`
- **Source**: setup audit; committed dossier leaks `/Users/aydansalois/...`.
- **Change**: Relativize all paths to the project root; drop `Generated:` timestamp from the .md body (keep it in the .json under `generatedAt`); write only when content (sans timestamp) changed; add `setup --dossier-dir <path>` with default unchanged but documented gitignore suggestion.
- **Validation**: run setup twice → second run leaves dossier untouched (`git status` clean); no absolute path in output (`grep -c "$HOME" docs/scip-query/*` → 0).
- **Why**: Machine-local noise in a committed artifact; regenerate this repo's dossier as part of the step (also fixes the stale 100/100 — docs audit).

#### 4.8 - setup-ci honesty and pinning

- [ ] **File**: `src/runtime/setup-ci.ts:31-51`
- **Source**: setup audit.
- **Change**: Pin `scip-query@<current version>` in the workflow (`npx scip-query@X.Y.Z`); detect non-npm repos and emit a commented TODO block instead of `npm ci`; add `actions/cache` for the scip-query cache dir keyed on the language lockfiles; keep base-ref logic (verified correct). Header comment states which languages need indexer install steps the workflow does not provide.
- **Validation**: `setup-ci --dry-run` output inspected in a test (string assertions on version pin + cache step).
- **Why**: Unpinned registry-latest execution in CI is a supply-chain hole the tool itself would flag.

#### 4.9 - Config strictness + diagnostics consolidation

- [ ] **File**: `src/runtime/config.ts:56, 66-264, 240, 334-341`; `src/runtime/commands/command-handlers.ts:678-699, 767-814, 793-797`
- **Source**: setup + docs audits.
- **Change**: (a) `config-validate` (and load-time, as warnings) reports unknown keys at every level (walk the parsed object against the known schema — the validator already enumerates known fields; add the complement check). (b) Either implement `watch.enabled` (gate the watch command) or stop writing it in `init` — pick implement: `watch` refuses to start when `enabled: false`. (c) Suppression rule: honor README by requiring `id` OR (`check` AND `file`), and make `config-validate` WARN that check+file entries waive an unbounded class (docs updated to match in 6.1). (d) Diagnostics: make `capability-matrix` an alias that prints a deprecation pointer to `capabilities --matrix`; `doctor` exits 0 on merely-stale index (stale is a warning; missing/broken stays 1); document `status` (machine) vs `doctor` (human) as the two canonical commands and fold `check-deps` body into `doctor` (keep `check-deps` as alias this release).
- **Testability**: unknown-key walker pure + table tests; doctor exit-code tests.
- **Validation**: `.scipquery.json` with `"autoRefres": true` → validate lists it; `doctor` on stale-index fixture exits 0 with warning.
- **Why**: Typo'd config silently ignored + five overlapping diagnostics confuse both agents and humans.

### Phase 5 — Docs truth pass

All steps: **Testability** = N/A (prose); validation = the stated grep/command. Ship as one commit series; regenerate nothing by hand that Phase 2/3 command changes will regenerate.

#### 5.1 - Fix the false claims
- [ ] **File**: `README.md:152, 167, 250-252`; `docs/AI_FAILURE_MODES.md:239, 278`
- **Change**: (a) Gate check list: "baseline regressions (with `--baseline`)". (b) Suppression sentence rewritten to match 4.9(c) behavior. (c) Replace `npm install -g scip-clojure` with the real distribution channel (check npm/GitHub for the actual package; if none exists publicly, say "requires a scip-clojure indexer on PATH" and link the source repo actually used in src/reindex/indexers.ts:117-132). (d) Fix scip-dart/scip-php owner links (find real upstreams; the `nicovince` URLs 404). (e) AI_FAILURE_MODES "one command, every check above" → enumerate what the default gate actually runs, generated from `DIFF_GATE_CHECKS` (see 5.2).
- **Validation**: link-check the README table (curl -sI each release URL → non-404); `grep -n "scip-clojure" README.md` shows the corrected text.

#### 5.2 - Generate the diff-gate check list everywhere
- [ ] **File**: `scripts/render-command-reference.ts` (extend), README + AI_FAILURE_MODES + DETECTOR_GUIDE check-list blocks
- **Source**: docs audit — four statements, three contents; only the generated one is right.
- **Change**: Add generated markers (`<!-- BEGIN GENERATED DIFF-GATE CHECKS -->`) rendered from `DIFF_GATE_CHECKS` (src/queries/impact/diff-gate.ts:29-47) into the three prose docs; `npm run docs:commands` refreshes all. DETECTOR_GUIDE "all three angles" sentence corrected to reference the generated block.
- **Validation**: `npm run docs:commands && git diff --exit-code docs/` after a no-op run.

#### 5.3 - Scope and freshness corrections
- [ ] **File**: `docs/API.md` (opening claim), `README.md:298-316` (init example), `README.md:214` (skill enumeration), `README.md:363` (plans link), `docs/AI_FAILURE_MODES.md:104, 185`, `docs/AGENT_GUIDE.md` (`-s/--scope` claim + threshold "recommendations" note), `skills/scip-language-playbook/SKILL.md:36-48` (add Go + Clojure rows), `docs/analyzer-inventory.md` (stale "currently reports")
- **Change**: per the docs-audit one-liners: API claim scoped to query commands; init example shows the real scaffold (languages + watch incl. `gitPollMs`/`autoRefresh`) with the rest labeled optional; skill enumeration generated from BUILTIN_SKILLS or explicitly completed (+directory-architecture, +tla-model-system); plans link either ships (`files` += `docs/plans/*.md`) or is dropped from the published README — choose ship, it's cheap; `isolated` described as callables; verify-oracle list corrected to the five real ones with clj-kondo labeled lint-level; scope-flag claim corrected; thresholds labeled "recommended values (defaults differ)"; inventory numbers regenerated or past-tensed.
- **Validation**: docs agent's per-line greps; `npm pack --dry-run | grep docs/plans` non-empty.

#### 5.4 - Sample-output blocks marked or regenerated
- [ ] **File**: `README.md` sample blocks (TWIN ~:115, incomplete-migration ~:122, health ~:176, self-audit ~:207), AI_FAILURE_MODES samples
- **Change**: Regenerate each block from a current run on this repo (preferred where the repo produces the finding) or add a caption `(illustrative — field layout may differ)`. Health block must reflect 2.x label changes ("validated predictors", coverage counts).
- **Validation**: manual diff of each block against a live run.

### Phase 6 — Skills consolidation

Frontmatter/name changes must keep `BUILTIN_SKILLS` (src/runtime/setup.ts) and the router table in lockstep — the setup test (tests/runtime/setup.test.ts:80-86) enforces the list; update all three together. Ship 6.1–6.3 as one deployable unit (install-set change), 6.4+ independently.

#### 6.1 - Merge scip-adoption + scip-query-setup → `scip-setup`
- [ ] **File**: `skills/scip-adoption/`, `skills/scip-query-setup/` → new `skills/scip-setup/`; `src/runtime/setup.ts` BUILTIN_SKILLS; router table `skills/scip-query/SKILL.md:36`
- **Source**: skills audit — near-identical workflows; router lists both with no tie-break.
- **Change**: One skill: setup flow = `setup --json` alone (drop the redundant install-skills/setup-hooks preamble — setup calls both internally, src/runtime/project-setup.ts:121,245); keep locality calibration as a section; end with the health-audit handoff. Delete both old dirs; router row now names one skill. `install-skills` handles stale symlinks for removed names (extend the installer: prune links it owns whose target dir no longer ships — reuse 4.6's ownership check).
- **Validation**: setup tests updated + green; `install-skills` on a fixture home with old links prunes them; router table has no two-owner rows.

#### 6.2 - Collapse the cleanup family to two skills with modes
- [ ] **File**: `skills/scip-debloat/`, `skills/scip-health-audit/`, `skills/scip-health-improve/`, `skills/scip-ai-cleanup/` → `skills/scip-cleanup-audit/` (report-only; modes: whole-repo | recent-AI-residue | score-framed) and `skills/scip-cleanup-improve/` (autonomous fixing; ratchet + verify loop); BUILTIN_SKILLS + router + tie-breaks updated (tie-break section should shrink to ≤ 3 rules)
- **Source**: skills audit — same detector sweep, five costumes; the real axes are audit-vs-act and scope.
- **Change**: Audit skill: one sweep section (the 12-command list, written once), three mode sections describing scope filters and report shape (keep ECHO/TWIN semantics and the descriptive-vs-normative rule — they're the good parts). Improve skill: the health-improve loop, with the fixed ratchet order (baseline written **after** the pass, compared at start of the next), and 3.1's `duplicate-bodies` added to the sweep. Frontmatter descriptions must not share trigger phrases across the two ("audit/report/rank" vs "fix/improve/raise score" — no "perfect code" in both).
- **Validation**: no two skill descriptions share a distinctive trigger bigram (`grep` the frontmatter set); setup tests green; router loop unchanged for other skills.

#### 6.3 - Single closeout: scip-verify only
- [ ] **File**: `skills/scip-query/SKILL.md:16-20`; `skills/scip-debug/SKILL.md:84-90`; `skills/scip-api-impact/SKILL.md:93`; `skills/scip-triage-issue/SKILL.md:92-93`
- **Source**: skills audit — double-gating everywhere.
- **Change**: Every workflow ends with exactly "Invoke `scip-verify`"; delete inline postcheck/diff-gate steps from callers (scip-verify already runs both, skills/scip-verify/SKILL.md:41-60).
- **Validation**: `grep -rn "diff-gate" skills/*/SKILL.md` → only scip-verify and _shared reference it as a step.

#### 6.4 - Fix broken/incorrect skill content
- [ ] **File**: `skills/concrete-plan/SKILL.md:147-153` (replace terminal `diff-impact` with re-running `plan-context` on cited targets), `:21-43` (cut CS-101 glossary entries; keep tool-specific terms only); `skills/scip-ai-cleanup` content moves to 6.2 but carry these fixes: pre-write reuse probe = `files`/`trace` not `similar <new-name>`, ratchet order fixed; `skills/scip-verify/SKILL.md:76-80` (generic phrasing for self-audit trigger); `skills/_shared/SKILL.md:36-38` (placeholder examples replace `processVegaMention`/`ChatService`), `:85` and all skills (drop `--full` from health invocations); `.agents/skills/typescript/AGENTS.md` (create `references/_sections.md` index or repoint the nine links); `.agents/skills/principal-maintainability-review/` + `scip-system-compression/` (gut to thin pointers at scip-maintainability, keeping unique reference material)
- **Validation**: a link-check script over `skills/**/*.md` + `.agents/skills/**/*.md` (add as `scripts/check-skill-links.mjs`, wired into `npm run lint` — cheap regex for relative .md links + existsSync) exits 0.

#### 6.5 - Generate the `_shared` command catalog
- [ ] **File**: `skills/_shared/SKILL.md:48-143`; `scripts/render-command-reference.ts`
- **Source**: skills audit — hand-written duplicate of the generated reference, currently in sync only by luck.
- **Change**: Wrap the Command Families block in generated markers and render it from descriptors during `npm run docs:commands` (compact one-line-per-command format; the docs file isn't installed with skills, so the copy must live in _shared — generation removes the drift risk, which the audit accepted as the right call).
- **Validation**: `npm run docs:commands && git diff --exit-code skills/_shared/SKILL.md` idempotent.

#### 6.6 - Codex metadata + README enumeration
- [ ] **File**: `skills/tla-model-system/agents/openai.yaml`, `skills/_shared/agents/openai.yaml` (create), `skills/scip-setup/agents/openai.yaml` (add `default_prompt`); `README.md:214`
- **Change**: Complete the yaml set (mirror an existing one); _shared's description must state "reference only — not a workflow" (belt-and-braces for runtimes ignoring `disable-model-invocation`). README enumeration completed per 5.3.
- **Validation**: every skill dir shipped in BUILTIN_SKILLS has `agents/openai.yaml` with `default_prompt` (script check in the 6.4 linter).

### Phase 7 — TLA P0 (strictness; the command stops being decorative)

All anchors in src/tla/ + src/runtime/query-commands/tla.ts; mutation tests from the review become regression tests.

#### 7.1 - Verify `reads`; reject type referents; per-fact waivers
- [ ] **File**: `src/tla/conformance.ts` (new read-scan alongside `collectWritesForRange`; referent-kind check in `aliasesForVariables`/`resolveActions`), `src/tla/model-contract.ts` (schema: replace per-action `allowUnknown` with `waive: {writes?: string[], reads?: string[], reason: string}`; keep `allowUnknown` parsing as deprecated alias mapping to a blanket waiver with reason `"legacy allowUnknown"`)
- **Source**: review §2 — reads parsed, never checked; dogfood maps variables to interfaces; allowUnknown on all actions.
- **Change**: (a) Read scan: identifier *reads* of variable aliases inside action ranges (AST: identifier references not in write position) compared to declared `reads` — undeclared reads = warning (`undeclared-read`), declared-but-unobserved = `missing-read-evidence` (waivable). (b) Variable referents must resolve to value-like symbols (var/let/const/field/property — SCIP kind check via the existing `SymbolMatch` kind); type/interface/type-alias referents produce an error finding `variable referent is a type; map the runtime state it describes`. (c) Waivers are per-fact with required reason; every waiver is counted and listed in output.
- **Testability**: extend the existing conformance fixture tests: read-scan cases (read, write-only, waived); type-referent case must fail (the current dogfood mapping is the fixture for this — see 7.3).
- **Validation**: `tla verify` on the *unmodified* dogfood spec now FAILS (type referents + no waiver reasons) — this is the point; 7.3 fixes the spec.

#### 7.2 - Honest PASS text, invariant check, ambiguity-aware resolution
- [ ] **File**: `src/runtime/query-commands/tla.ts:142-190`; `src/tla/conformance.ts:534-542`
- **Change**: (a) `resolveReferent` uses 1.1's `resolveSymbol`; ambiguous referents (total > 1 with no path qualifier) → warning finding naming alternates. (b) PASS block becomes an itemized proof summary: `checker: tlc PASS | writes: N verified, M waived (reasons listed) | reads: … | calls: … | traces: K steps` — and prints `NOTHING PROVEN ABOUT WRITES` style warnings when a whole dimension was waived; the sentence "model, mapping, and checked code evidence agree" is removed unless zero waivers. (c) Cross-check the mapping's `invariants` list against the parsed `.cfg` INVARIANT lines; missing → warning (`invariant listed in mapping but not checked by config`).
- **Testability**: regression tests encoding the review's mutation tests: swapped-referent mapping must now produce findings (referent kind/role mismatches will surface via 7.1's read/write scans — assert at minimum it cannot print an unqualified PASS with 0 verified writes); allowUnknown-stripped mapping reproduces the 5 unknowns.
- **Validation**: rerun review mutation test A → no unqualified PASS; exit code policy unchanged otherwise.

#### 7.3 - Fix the dogfood spec to model real state, and bundle the checker path
- [ ] **File**: `specs/tla-feature/*` (remap variables to actual runtime state: e.g. `TlaVerifyResult.exitCode` decision modeled over the real mutable flow in tla.ts — or narrow the spec to the tool-runner state machine whose statuses are genuinely finite); `src/tla/tool-runner.ts:174-182` (jar resolution)
- **Change**: (a) Rewrite the mapping per 7.1's rules with zero blanket waivers (per-fact waivers with real reasons allowed); the spec must be able to fail (mutation-test it once in a unit test by flipping a guard). (b) Jar resolution order gains `<cache-dir>/tla2tools.jar` + new `scip-query tla fetch-tools` subcommand that downloads the pinned release (sha256-verified constant) into the cache — mirror the vendor/scip download pattern; `--checker auto` message on skip now says exactly `run 'scip-query tla fetch-tools' or set TLA_TOOLS_JAR`.
- **Validation**: `tla verify specs/tla-feature/TlaVerifier.tla` passes with ≥ 1 verified write and 0 blanket waivers on a machine with the fetched jar; CI-safe test uses `--checker none` and asserts conformance findings only.
- **Why**: The shipped example is the tutorial; today it teaches opting out.

### Phase 8 — Hardening backlog (S items, batch at will)

- [ ] 8.1 `errorKey` count-sensitivity (covered by 1.3 change — verify it landed for the masked-duplicate case).
- [ ] 8.2 `watch`: refuse second watcher via lockfile presence message; document foreground-only.
- [ ] 8.3 Update-notice: exempt `hook-context`/`hook-stop` from the npm registry check (src/runtime/update-notice.ts:108-116).
- [ ] 8.4 SessionStart matcher: drop the redundant `"startup|resume|clear|compact"` enumeration (agent-hooks.ts:303).
- [ ] 8.5 `skills-lock.json` at repo root: delete or README-note (foreign artifact).
- [ ] 8.6 Baseline identity rename note: document `detector:file:shortName` identity in health docs; renames = one fixed + one new (accepted, documented).
- [ ] 8.7 `dead` human output: print per-section counts + top 20 by LOC with `--full` for the rest (JSON unchanged — uncapped).
- [ ] 8.8 Stale root `index.db` fallback (src/runtime/cli-context.ts:22-23): when falling back to a project-root db, print its build date + staleness warning.

### Phases 9–10 — TLA P1 (scaffold) and P2 (trace validation) — **gated, do not start unprompted**

Specified in the [redesign proposal](../reviews/2026-07-01-tla-redesign-proposal.md) §3 Pillars A and B. When green-lit, expand each into plan steps using this file's format. Acceptance previews: P1 — `tla scaffold src/runtime/tool-runner.ts` emits a spec+mapping where every variable referent is value-like, domains come from union types, and `tla verify` passes with ≥ 1 verified write, zero hand edits. P2 — `tla instrument` + running the existing test suite yields ≥ 1 trace; `tla verify --traces` generates a TraceSpec and TLC accepts it; a deliberately broken guard in the model is rejected with the divergent step named.

---

## Stress-Test Findings

- **Blast radius**: 1.1 touches every symbol-resolving command — mitigated by keeping `findFirstSymbolMatch` as a compatible wrapper; the registry-walking test in 2.1 catches missed commands. 6.1/6.2 change the installed skill set — installer pruning added in 6.1 covers stale symlinks.
- **One-way doors**: 4.1 (postinstall defang — release-note), 1.6 (suppression IDs — made two-way via dual-hash matching), 4.4 (hook location — `--remove` migration provided), 6.1/6.2 (skill renames — installer prunes; old names gone from routers). Flag all four in the release notes.
- **Valid intermediate states**: every phase ships alone; within phases, 1.1→1.2 and 4.3→4.5 are ordered; 2.1 before 3.1 (new detector inherits labeling); 1.1 before 7.2.
- **Failure modes**: 1.5 AST-unavailable fallback defined; 4.3 background refresh failure lands in meta.json (surfaced by `status`); 7.3 jar fetch is sha-pinned and offline-safe (verify still runs with `--checker none`).
- **Concurrency**: background refresh (4.3) uses the existing reindex lockfile (src/reindex/index.ts:759-780) — no new shared state; 3.1 caching goes through evidence-cache like other detectors.
- **Data integrity**: suppression dual-matching (1.6) protects existing `.scipquery.json` entries; dossier rewrite (4.7) is content-keyed; baseline files unaffected until 8.6's doc note.
- **Human experience**: the consent changes (4.1/4.4) make first-run require one explicit command — README Quick Start must be updated in the same commits (add to 4.1/4.4 validation: README grep).
- **Reuse check**: every new unit justified in the Reuse Audit; no new wrapper/flag beyond those listed.

## Execution Order and Ship Order

1. **Phase 1** (1.3 → 1.4 → 1.1 → 1.2 → 1.5 → 1.6 → 1.7 → 1.8) — correctness first; each step deployable.
2. **Phase 2** (2.1 → 2.2 → 2.3 → 2.4) — labeling architecture before new detectors.
3. **Phase 3** (3.1 → 3.2) — includes consolidating this repo's own escapeRegex duplicates as dogfood proof.
4. **Phase 4** (4.2 first — one line; then 4.3 → 4.5 → 4.4 → 4.1 → 4.6 → 4.7 → 4.8 → 4.9) — release-note the doors.
5. **Phase 5** — after 2/3/4 so regenerated blocks reflect final behavior.
6. **Phase 6** (6.1+6.2+6.3 as one unit; 6.4–6.6 independent).
7. **Phase 7** (7.1 → 7.2 → 7.3) — after 1.1.
8. **Phase 8** — anytime after Phase 4.
9. **Phases 9–10** — on explicit go-ahead only.

After each phase: run working-agreement #2 gates, then hand off for review (Claude) before the next phase. Reviewer checks: step validations reproduced, no unfixed gate findings, release notes updated for door items.

## Summary of files

- **Create**: `src/queries/cleanup/duplicate-bodies.ts` (+ registration + tests), `scripts/check-skill-links.mjs`, `skills/scip-setup/`, `skills/scip-cleanup-audit/`, `skills/scip-cleanup-improve/`, `skills/_shared/agents/openai.yaml`, `skills/tla-model-system/agents/openai.yaml`, `.agents/skills/typescript/references/_sections.md`, `tla fetch-tools` + `uninstall` command modules.
- **Edit (major)**: symbol-lookup.ts, diff-impact.ts, diff-gate.ts, cleanup-verify.ts, cleanup/handlers.ts, command-execution.ts, command-docs.ts, command-descriptors.ts, agent-hooks.ts, setup.ts, project-setup.ts, scip-cli.ts, config.ts, health-dossier.ts, setup-ci.ts, self-audit.ts, similar-signatures.ts, git-history.ts, co-change.ts, conformance.ts, model-contract.ts, tla.ts, tool-runner.ts, render-command-reference.ts, README.md, AGENT_GUIDE.md, DETECTOR_GUIDE.md, AI_FAILURE_MODES.md, API.md, most `skills/*/SKILL.md`, `specs/tla-feature/*`.
- **Delete**: `skills/scip-adoption/`, `skills/scip-query-setup/`, `skills/scip-debloat/`, `skills/scip-health-audit/`, `skills/scip-health-improve/`, `skills/scip-ai-cleanup/` (content merged), repo-root `skills-lock.json` (8.5), the 7+ in-repo `escapeRegex`/`escapeRegExp` duplicates (3.1 consolidation).
- **Verify**: 490-test suite green throughout; `docs:commands` idempotent; review mutation tests A/B encoded as regressions (7.2); `npm pack` includes docs/plans.
