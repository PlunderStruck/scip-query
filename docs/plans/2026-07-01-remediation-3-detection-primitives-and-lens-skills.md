# Remediation Plan 3 — Detection primitives + lens skills

Date: 2026-07-01
Executor: Codex (implementation) → Claude (review pass per phase)
Inputs: [Round-1 review](../reviews/2026-07-01-critical-review.md) · [Round-2 review](../reviews/2026-07-01-critical-review-round2.md) · design discussion 2026-07-01
Builds on: [Plan 1](2026-07-01-review-remediation.md) (committed 56865c7) and [Plan 2](2026-07-01-remediation-2-round2-and-regex.md) (pending — Plan 3 phases 17–18 are independent of Plan 2; phase 19 should follow Plan 2's frontend work if both run).

**Working agreement from Plan 1 applies verbatim** (commit per step, gates per phase, docs:commands regeneration, BLOCKED protocol, anchor re-verification). Phases numbered 17–21.

## Goal

Make the tool able to detect the *classes* of defect the two review rounds found in its own repo, and reshape skills into goal-scoped lenses. Explicitly NOT a goal: shrinking the 86-command CLI surface. Commands stay; what changes is that each skill presents a model with a small, named command allowlist composed for one problem, so the *interaction* surface per task is 4–8 commands instead of the catalog. Done = the two new detector primitives find the review rounds' historical defects when run against pre-fix commits, every bundled skill declares and renders its allowlist, and the calibration run on two external repos is recorded.

## Why these primitives (the defect-class map)

Round 1+2 findings, taxonomized — each class maps to a mechanical detector or a judgment skill:

| Defect class | Historical instances (all real, all missed by existing detectors) | Answer |
| --- | --- | --- |
| Twin drift: same concept in siblings, silently different semantics | `similar` vs `convergence` similarity; fan-in vs fan-out self-file policy; diff-gate vs doc-drift citation classifiers; React/Vue function families (`compareProfiles`, `pressureResult`, …) with drifted thresholds; `escapeRegex`×7 + `escapeRegExp`×3 | **Detector** (17.1) + gate check (17.2) + lens skill (19.2) |
| Enumeration rot: hand-written tables asserting derivable facts | drift-policy missing `src/tla` (73% FP); `SOURCE_FACT_SUPPORT` vs registry; `_shared` catalog (now generated); README skill list | **Config primitive** (17.3) + gate check |
| Asserted-not-probed claims | capability matrix vs tree-sitter runtime; TLA unqualified PASS; "safe to delete" | **Skill** (19.3) — procedure over refs/code/grep with a rubric |
| Unreachable/dead branches | `jsx_fragment` branch the grammar never emits | **Skill** (19.4) — generate minimal inputs per branch, run the real parser |
| Precision decay / alert fatigue | drift 73% FP; the 31-finding Stop-hook wall this session; duplicate-bodies flagging 11 intentional 1-LOC handler stubs | **Feedback loop** (18) + calibration (21) |

## Reuse Audit

- Twin-drift grouping: reuse `duplicate-bodies`' body normalization + hashing (src/queries/cleanup/duplicate-bodies.ts) and the leaf-name grouping already used by `similar-signatures`; new module justified only for the *comparison* logic (same-name, different-body).
- Coverage contracts: extend `.scipquery.json` parsing/validation in src/runtime/config.ts alongside `declaredCouplings` — same shape, same validator; the checker runs inside diff-gate as a new check in `DIFF_GATE_CHECKS` (established extension point, Plan 1 generated the doc lists from it).
- Detector precision ledger: extend the existing evidence-cache + the validation-axis machinery in src/queries/health/health-report.ts — the lift computation exists; this closes its unused loop (round-1 finding "computed but never feeds classification").
- Skill allowlists: frontmatter extension rendered by the existing `scripts/render-command-reference.ts` generated-block machinery (Plan 1, 6.5) — no new renderer.
- New lens skills are new SKILL.md files only; no new commands beyond `twin-drift`.

## Testability Design

| Behavior | Test seam | Injected deps | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Twin grouping | `groupTwins(defs, bodies)` | fixture defs | name/body comparison | db reads | `TwinGroup {leaf, members[], divergent}` |
| Coverage contract check | `checkCoverageContract(contract, actualKeys)` | none | set diff | key-source resolvers | findings on missing/extra keys |
| Key-source resolvers | `resolveContractSource(spec, db, fs)` | fs, db fixtures | spec parsing | dir listing / db query | `string[]` |
| Precision ledger | `recordFindingOutcome(ledger, finding, outcome)` / `detectorPrecision(ledger)` | clock via param | trend math | evidence-cache rw | per-check `{seen, resolved, suppressed, ignoredStreak}` |
| Allowlist rendering | render function on skill frontmatter | none | markdown gen | file write via docs:commands | generated block markers |

---

## Phase 17 — Two mechanical primitives

### 17.1 - `twin-drift` detector
- [ ] **File**: new `src/queries/cleanup/twin-drift.ts` + registration per Plan-1 working agreement #3; reuse normalization from `src/queries/cleanup/duplicate-bodies.ts` (export its `normalizeBody`/hash helpers rather than copying — that would be twin drift)
- **What (evidence)**: same-leaf-name functions with different bodies across files are invisible today: `duplicate-bodies` requires *identical* bodies, `similar` requires callee overlap, `similar-signatures` requires same type shape. Round-2's React/Vue family (`compareProfiles` in 5 files, `recommendationFor` in 3, drifted thresholds) and the historical `escapeRegex` vs `escapeRegExp` near-name split were all missed.
- **Change**: group indexed callables by leaf name (plus near-names: case-insensitive match and edit-distance ≤ 2 for names ≥ 8 chars — catches escapeRegex/escapeRegExp); within a group spanning ≥ 2 files, compare normalized bodies. Report groups as: `IDENTICAL` (defer to duplicate-bodies — suppress here), `DIVERGENT` (same name, body similarity in [0.3, 1.0) by normalized-token Jaccard — the finding), or unrelated (< 0.3 — homonyms like `render`, suppress). Output per group: members with file:line + LOC, pairwise divergence %, and the first differing normalized token run (so the agent sees *where* they drifted). Flags: `-s/--scope`, `--min-similarity` (default 0.3), `--include-homonyms`, `-n`, `--full`, `--json`. Evidence tier: `heuristic` (descriptor field per Plan-1 2.1). Exempt: declaration-merged overloads, `index.ts` re-export wrappers (reuse barrel classification from src/analysis/file-classifier.ts).
- **Testability**: `groupTwins` pure over `{leaf, file, normalizedBody}` records; fixtures: drifted twins (must flag), identical (must defer), homonyms (must suppress), near-name pair (must flag).
- **Validation**: run against commit `ec66963` (pre-remediation) via a worktree: must report the React/Vue `compareProfiles`/`recommendationFor` families and the escapeRegex/escapeRegExp near-name group. On current HEAD: the React/Vue families still exist until Plan-2 14.6 lands — expect findings; that's correct, not noise.
- **Why**: this is the single highest-yield detector for the defect class both review rounds ranked most corrosive.

### 17.2 - diff-gate `twin-partner` check
- [ ] **File**: `src/queries/impact/diff-gate.ts` (`DIFF_GATE_CHECKS` + a new check module beside the co-change-partner check)
- **What**: one-sided fixes are the live failure mode (citation classifier fixed in diff-gate, not doc-drift). File-level co-change can't see symbol-level twins.
- **Change**: for each changed symbol in the diff (Plan-1's attribution now includes initializer edits), look up its twin group (17.1's grouping, cached in evidence.db); if a DIVERGENT-or-IDENTICAL twin exists in an *unchanged* file, emit `[twin-partner] <symbol> changed but its same-name twin <file:symbol> did not — verify the change shouldn't apply to both, or consolidate them.` Severity/remediation shaped like co-change-partner; suppressible with the standard identity (check, symbol, file — Plan-1 1.6 scheme). Register in `DIFF_GATE_CHECKS` so the generated doc lists update via `npm run docs:commands`.
- **Testability**: fixture repo with a twin pair; edit one → finding; edit both → no finding; suppression respected.
- **Validation**: fixture tests; on this repo, editing one React pressure helper without its Vue twin triggers the check.

### 17.3 - Coverage contracts (`coverageContracts` in .scipquery.json)
- [ ] **File**: `src/runtime/config.ts` (schema + validation, beside `declaredCouplings`), new check module wired into `diff-gate` and `health` hygiene
- **What**: enumeration rot is only detectable today by a human audit. The drift-policy hole (73% FP) existed for a day; the capability-table drift for longer.
- **Change**: config shape:
  ```json
  {
    "coverageContracts": [
      {
        "name": "drift layer policy covers src dirs",
        "file": "src/queries/cleanup/drift-policy.ts",
        "keys": { "type": "object-literal-keys", "identifier": "allowed" },
        "mustEqual": { "type": "top-level-dirs", "path": "src" },
        "allowExtra": false
      }
    ]
  }
  ```
  Key extractors (v1): `object-literal-keys` (AST: keys of a named object literal), `string-array` (elements of a named array), `markdown-list` (link/backtick names in a marker-delimited block). Ground-truth sources (v1): `top-level-dirs`, `file-glob` (basenames), `registered-commands` (descriptor ids), `builtin-skills`. Checker: set-compare, emit `[coverage-contract] <name>: missing <keys>` (and extras when `allowExtra: false`). Runs in `health` (hygiene) and in `diff-gate` when either side's file changed. `config-validate` validates contract specs (unknown extractor/source types rejected — Plan-1 4.9's unknown-key strictness extended).
- **Seed contracts in this repo**: drift-policy `allowed` ↔ `src/*` dirs; `BUILTIN_SKILLS` ↔ `skills/*` dirs (defense-in-depth alongside the lockstep test); README's skill enumeration ↔ BUILTIN_SKILLS (markdown-list extractor); language registry ids ↔ `SOURCE_FACT_SUPPORT` keys (until Plan-2 13.1 merges those tables — then retire the contract).
- **Testability**: extractors pure over fixture sources; checker pure over key sets; end-to-end fixture with a violated contract.
- **Validation**: delete the tla entry from drift-policy in a scratch worktree → `health` and `diff-gate` both flag it; restore. All four seed contracts pass on HEAD.
- **Why**: converts "audit finding months later" into "gate failure the day it rots" — the exact mechanism this repo needed.

## Phase 18 — Close the precision feedback loop

### 18.1 - Finding-outcome ledger
- [ ] **File**: `src/storage/evidence-cache.ts` (new table, same versioning discipline), diff-gate + health finding pipelines
- **What**: the gate showed the same 31 findings at every Stop for hours this session; nothing tracks that its findings are being ignored. The validation axis computes per-detector lift and (round-1 finding) feeds nothing.
- **Change**: persist per finding identity (Plan-1 1.6 ids): first-seen, last-seen, times-shown, outcome (`resolved` — id stops matching because the underlying code changed; `suppressed`; `still-open`). Derive per-check stats: open-finding age distribution, resolution rate, suppression rate. Two consumers: (a) diff-gate `--hook` mode prepends `N findings, M shown before and unresolved (oldest: X days)` and, when a check's resolution rate over the trailing 50 findings is < 10%, appends `(the <check> check's findings are rarely acted on in this repo — consider suppressing with reasons or tuning its config)`; (b) `health --json` gains `detectorPrecision` per check alongside the existing validation lift.
- **Testability**: ledger math pure over injected event sequences; clock injected. No behavior change to which findings are *emitted* — this phase only reports; downranking stays a human/config decision (deliberate: auto-suppression would hide real findings behind past neglect).
- **Validation**: replay this session's scenario in a fixture (same 30 doc-reference findings across 3 runs) → hook output carries the unresolved-streak line.

## Phase 19 — Lens skills

### 19.1 - Allowlist frontmatter + generated rendering for ALL bundled skills
- [ ] **File**: every `skills/*/SKILL.md`; `scripts/render-command-reference.ts` (extend the Plan-1 6.5 generator); `skills/_shared/SKILL.md`
- **What**: skills currently point at the full generated catalog in `_shared`. The design decision (user, 2026-07-01): keep all 86 commands, but each skill should name the exact subset it drives, so the model's working set per goal is 4–8 commands.
- **Change**: (a) frontmatter gains `commands:` — a list of exact invocation templates with flags, e.g. `- scip-query twin-drift -s <scope> --json`. (b) The generator validates every entry against descriptors (unknown command/flag fails `docs:commands` — the same guarantee the catalog has) and renders a `## Commands for this skill` block (marker-delimited) into each skill body: one line per command — template, one-clause purpose, when-in-the-workflow. (c) `_shared`'s full catalog stays (reference of last resort) but every skill body's guidance says: use the skill's own command block first; open `_shared` only when the lens is insufficient. (d) Router table gains a per-row 3-command preview so routing can happen without loading the target skill.
- **Testability**: generator validation is the test (CI fails on a bad allowlist); add one unit test for the renderer.
- **Validation**: `npm run docs:commands && git diff --exit-code skills/` idempotent; every bundled skill has a commands block; link-check green.

### 19.2 - `scip-twin-drift` lens skill
- [ ] **File**: new `skills/scip-twin-drift/SKILL.md` (+ agents/openai.yaml; BUILTIN_SKILLS + router row + tie-breaks updated together — lockstep test)
- **Change**: allowlist: `twin-drift`, `duplicate-bodies`, `code <symbol>`, `refs <symbol>`, `diff-gate --json`. Workflow: run detector → for each DIVERGENT group, read both bodies with `code`, classify the divergence (intentional variation / drifted policy / one-sided fix), pick the canonical twin by consumer count (`refs`), then either consolidate to one exported helper or record the intent gap as a comment/waiver. Completion: `twin-drift` reports no unclassified DIVERGENT groups in scope; gates pass.
- **Validation**: frontmatter description doesn't collide with scip-cleanup-* triggers (distinctive bigrams: "twin", "same-name", "one-sided fix"); dry-run the workflow on this repo's React/Vue family.

### 19.3 - `scip-claim-audit` lens skill
- [ ] **File**: new `skills/scip-claim-audit/SKILL.md` (+ registration trio as 19.2)
- **Change**: the procedure my audit agents ran, encoded: allowlist `files`, `refs`, `code`, `trace`, `capability-matrix --json`, plus plain grep. Steps: (1) inventory output-facing status vocabulary (grep src for user-visible strings: available/verified/safe/PASS/complete + their renderers); (2) for each, `refs`/`code` the producing function and classify: **derived** (traces to a probe/computation), **asserted** (constant/table), **hedged** (labeled candidate/heuristic); (3) every *asserted* status becomes a finding with the round-1/2 severity rubric (asserted + agent-facing + trust-bearing = high); (4) report table: claim → producer file:line → classification → fix (probe it, generate it, or soften the language). Completion: every status word in scope classified; findings filed (report artifact under `docs/scip-query/`, the Plan-1 standard root).
- **Validation**: dry-run on `src/runtime/project-readiness.ts` — it must rediscover round-2's capability-matrix finding (that's the acceptance test for the skill text).

### 19.4 - `scip-probe-reachability` lens skill
- [ ] **File**: new `skills/scip-probe-reachability/SKILL.md` (+ registration trio)
- **Change**: for parser/AST-consuming code (the react-profile/`jsx_fragment` class): allowlist `outline`, `code`, `trace`, plus writing scratch probe scripts under the session scratchpad (never the repo). Steps: enumerate branch conditions on node-type/shape in the target file (`outline --signatures` + `code`); for each branch, construct the minimal input that should reach it; execute the real parser (node script importing the built dist) and record reached/unreached; unreached branches become findings (dead branch, or wrong node-type string). Completion: every node-type branch in the target file has a reached probe or a filed finding.
- **Validation**: dry-run against the pre-fix react-profile.ts (worktree at ec66963) — must rediscover the `jsx_fragment` dead branch.

### 19.5 - Router + AGENTS.md alignment
- [ ] **File**: `skills/scip-query/SKILL.md` (router), `src/runtime/agent-setup.ts` seeded block
- **Change**: router table adds the three new lenses with one-line triggers; tie-breaks updated (twin-drift vs cleanup-audit: "same-name/consolidation questions → twin-drift; general bloat → cleanup-audit"). Seeded AGENTS.md block mentions the lens principle in one sentence ("skills carry their own command shortlist — prefer it over the full catalog").
- **Validation**: lockstep test green; router has no two-owner rows.

## Phase 20 — Detect-the-past regression suite

### 20.1 - Historical-defect fixtures
- [ ] **File**: new `tests/regression/detects-historical-defects.test.ts` + small fixtures extracted from the pre-fix code
- **What**: the review rounds are a labeled defect corpus; without tests, the new primitives can regress to missing exactly what they were built for.
- **Change**: fixtures reproducing (in miniature): the escapeRegex near-name family (twin-drift must flag), the drift-policy missing-key scenario (coverage contract must flag), the one-sided classifier fix (twin-partner gate check must flag), the 11× 1-LOC handler boilerplate (duplicate-bodies must NOT flag after 21.2's calibration — encode as the expected-exemption test). Each test names the review finding it encodes.
- **Validation**: suite green; each test's docstring links the review section.

## Phase 21 — External calibration (gated: requires the user's repos; read-only on them)

### 21.1 - Calibration run on Stable_Management and Vega_2.0
- [ ] **What**: both repos exist locally (`/Users/aydansalois/Documents/GitHub/Stable_Management`, `.../Vega_2.0`). Vega was the historical perf-tuning corpus (partially seen); Stable_Management is the clean test.
- **Change**: for each repo: index; run the detector set (twin-drift, duplicate-bodies, drift, recent-duplicates, co-change, doc-drift, complexity-hotspots post-Plan-2) + `health`; retro-run `diff-gate` on each of the last 20 real commits (worktree per commit). Record per detector: finding counts, spot-classified precision (sample 10 findings each, hand-classify actionable/noise), and wall-clock at that index size. Deliverable: `docs/validation/2026-07-XX-external-calibration.md` with a per-detector verdict (keep / retune threshold X→Y / demote to opt-in).
- **Rules**: strictly read-only on both repos (no config writes, no hooks, no reindex artifacts outside the cache dir); indexes go to the default cache location.
- **Validation**: the report exists with all cells filled; every "retune" verdict lands as a follow-up config-default change with the report cited as Source.

### 21.2 - Apply calibration
- [ ] **File**: detector defaults per 21.1's verdicts; known candidate already observed: `duplicate-bodies` default `--min-loc` 1 → 3 (or a registration-boilerplate exemption) — it currently flags 11 intentional 1-LOC command-handler stubs in this repo.
- **Validation**: 20.1's expected-exemption test flips green; re-run 21.1's worst detector spot-check post-tune.

---

## Stress-Test Findings

- **Twin-drift noise risk**: leaf-name grouping on common names (`get`, `parse`) — mitigated by the < 0.3 homonym suppression, barrel/overload exemptions, and 21.1 calibration before any gate default. The gate check (17.2) ships **advisory** (never exit-nonzero-by-itself) until calibration says otherwise.
- **Coverage-contract extractor fragility**: AST key extraction depends on tree-sitter availability — reuse the Plan-2 13.2 disclosure pattern (`parser-unavailable` reason, contract check skipped WITH a finding saying so, never silently green).
- **Ledger privacy/size**: outcome ledger stores finding ids + timestamps only (no prompt/content); capped at 5k rows per check with FIFO eviction.
- **One-way doors**: none — new detectors are additive, new config keys optional, skills additive; 21.2's default changes are config-revertible.
- **Ordering**: 17.1 → 17.2 (gate consumes groups) and → 19.2 (skill drives detector); 18 independent; 19.1 before 19.2–19.4 (they declare allowlists); 20 after 17; 21 last.
- **Valid intermediate states**: every phase ships alone; 19.x skill additions keep the lockstep test green per commit.

## Summary of files

- **Create**: `src/queries/cleanup/twin-drift.ts` (+ registration + tests), coverage-contract module + config schema additions, evidence-cache outcome table, `skills/scip-twin-drift/`, `skills/scip-claim-audit/`, `skills/scip-probe-reachability/` (each with agents/openai.yaml), `tests/regression/detects-historical-defects.test.ts`, `docs/validation/2026-07-XX-external-calibration.md` (21.1 output).
- **Edit**: `src/queries/impact/diff-gate.ts` (twin-partner check), `src/runtime/config.ts` (coverageContracts), `src/queries/health/*` (contract + precision surfacing), `scripts/render-command-reference.ts` (allowlist blocks), every `skills/*/SKILL.md` (commands frontmatter), router + agent-setup seeded block, `.scipquery.json` (seed contracts), `duplicate-bodies` defaults (21.2).
- **Verify**: gates per phase; detect-the-past suite green; `docs:commands` idempotent across skills; lockstep test green at every commit.
