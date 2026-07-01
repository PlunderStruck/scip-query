# scip-query — Critical Review

Date: 2026-07-01 · Version reviewed: 0.10.12, working tree (mid skill-rewrite) · Method: rebuilt `dist` from source; ran the repo's own gates (490/490 tests, typecheck, lint all pass); executed ~40 commands live against this repo; mutation-tested the TLA verifier; four scoped audits (skills, docs, setup/hooks, evidence model) with file:line verification.

The tool's promise: **"Evidence and verification for AI coding agents. Map the repo. Reuse what exists. Finish the refactor. Gate the diff"** — with an explicit honesty model (evidence tiers, itemized scores, falsifiability). This review measures the tool against that promise.

Companion: [TLA+ subsystem redesign proposal](2026-07-01-tla-redesign-proposal.md).

---

## Executive summary — the twelve findings that matter most

1. **Ambiguous symbol lookups silently return one arbitrary match.** `refs escapeRegex` answers from 1 of 7 same-named definitions with zero disclosure, in human and JSON output. The tier-1 "compiler fact" commands are the least honest in the tool. (§1.1)
2. **`diff-gate` misses edits inside multi-line const initializers.** A one-line change to `BUILTIN_SKILLS` (a symbol with real cross-file consumers) reported "0 symbols changed, 0 consumers" and PASSed — because the index records the definition as a single line. Schemas, config tables, and lookup maps — the tool's marquee scenario — are invisible to symbol-level gating. (§1.2)
3. **`cleanup-plan --verify` can print COMPILER-VERIFIED on a failed check.** The checker's `ok` flag is computed and never read; verification passes on any failure output lacking the literal word "error" (`go build`, ruff's "Found 2 errors."). `cleanup-apply --verified` then deletes code. (§1.3)
4. **The tool cannot find its own textbook rot.** This repo contains `escapeRegex` duplicated 7× plus `escapeRegExp` 3× (near-identical bodies). `similar` (callee fingerprints) can't see them, `recent-duplicates` windows them out, `similar-signatures` buries them in a noise cluster, and `health` reports 97/100. The #1 marketed failure mode — "agents re-implement helpers" — is undetectable in the tool's own codebase. (§1.4)
5. **`tla verify` is decorative in its shipped configuration.** A mutation test binding TLA actions to the *wrong functions* passes with exit 0 and "PASS: model, mapping, and checked code evidence agree." The dogfood mapping maps every variable to a TypeScript *interface* and opts all five actions out via `allowUnknown`; `reads` and `invariants` in the mapping are never checked at all. (§2)
6. **`npm install` silently mutates `$HOME` and can run package managers.** postinstall symlinks skills into three agent roots and, when `scip` is missing, runs `brew install`/`go install …@latest` — network, unpinned, failures swallowed by `|| true`. Also: `src/runtime/scip-cli.ts:9` points the manual-download URL at `github.com/scip-code/scip` while brew/go use `sourcegraph/scip` — one is wrong, and possibly a binary-planting vector. (§3.1)
7. **Every prompt pays a repo-wide SHA-256 fingerprint, and a stale index triggers a synchronous reindex — which can itself run `brew`/`npm install -g`.** The UserPromptSubmit hook hashes every tracked+untracked file per prompt and reindexes inline (blowing the 60s hook timeout on large repos, then retrying next prompt). Hooks are written to the **checked-in** `.claude/settings.json`, executing a PATH-resolved `scip-query` for every teammate. (§3.2)
8. **The keyword router injects wrong routes into every prompt.** Substring matching (`'wrong'`→debug, `'review'`→review, `'install'`→setup) produced three simultaneous routes for this review's own opening prompt. No off switch exists. (§3.3)
9. **The default Stop hook runs the full diff-gate every turn and shows the result to nobody actionable** — "warn" mode emits a UI string the model never sees, computed against a stale-by-design index. (§3.4)
10. **README makes several flatly false claims**: `npm install -g scip-clojure` (package doesn't exist), `config-validate` "rejects suppressions without an identity" (id-less suppression in this very repo validates clean — and silently waives all echo findings in a file, forever), "baseline regressions" in the default gate (opt-in flag), two 404 indexer links. (§4)
11. **Heuristic-tier labeling is two disconnected mechanisms and the newest commands fall through**: recent-duplicates, doc-drift, co-change, incomplete-migration, and diff-gate emit no runtime disclaimer; five commands ship `--json` with no evidence/tier field; `dead` and `health` say **"safe to delete"** for tier-1 facts while README:202 reserves "safe" for tier-4. (§5)
12. **23 skills for one promise, with colliding triggers.** Adoption vs setup are the same workflow twice (the router itself lists both and refuses to choose); five cleanup skills are one workflow in five costumes; the flagship `concrete-plan` ends by running `diff-impact` on a diff that doesn't exist yet. (§6)

The consistent shape: **the epistemics are real but artisanal.** Almost every honesty mechanism exists (tiers, itemized deductions, suppressions-with-reasons, disclosure of caps) — but there is no architectural choke point forcing every command through it, so the most agent-facing surfaces (refs, diff-gate JSON, hooks, the newest detectors) are exactly where the honesty gaps live.

---

## 1. Where the core promise breaks (evidence integrity)

### 1.1 Silent ambiguity resolution — the root poison
- `findFirstSymbolMatch` (src/symbols/symbol-lookup.ts:41-58) chains exact → file:line → path → fuzzy and always returns one row; ties keep the first SQL row, and the scorer prefers the *shortest* body (symbol-lookup.ts:329).
- Live: `escapeRegex` has 7 definitions; `refs escapeRegex` returns only source-stripper.ts's references. `refs --json` contains **no field identifying which symbol was resolved** and no "6 other matches" notice (src/runtime/query-commands/navigation.ts:91-94). `trace`/`plan-context` at least print the resolved definition; `refs` discloses nothing.
- Unknown symbols: `trace zzz` exits **0** with empty DEFINITION/REFERENCED-BY sections — indistinguishable from "exists, unreferenced". `plan-context` near-misses (`runDiffGate` vs `diffGate`) return a bare one-liner with no candidates. Every wrong answer here poisons downstream plans, gates, and deletions.
- Zero tests cover ambiguous-query UX.
- Fix: on multi-match, print/JSON the resolved symbol + match count + how to path-qualify; exit nonzero (or emit `"matched": false`) on no-match; suggest nearest names.

### 1.2 diff-impact/diff-gate blind spot: initializer edits attribute to no symbol
- Repro (this session): working tree contained a one-line addition inside `export const BUILTIN_SKILLS = [...]` (src/runtime/setup.ts:9). `diff-impact` → `changedFiles: [setup.ts], changedSymbols: [], affectedConsumers: []`. `diff-gate` → PASS.
- Mechanism: the SCIP index records the definition at `setup.ts:8-8` (identifier line only); `definitionTouchesChangedRange` (src/queries/impact/diff-impact.ts:535-543) intersects hunk lines with that 1-line range → no overlap → the edit belongs to no symbol → every symbol-keyed gate check (echo, new-dead, impact) skips it. The symbol has real consumers (command-descriptors.ts) that would have been reported.
- This is precisely the "schema/config change" class the README and AGENTS.md tout. Only the file-level co-change check can catch it, and only when history happens to cooperate.
- Fix: widen attribution to enclosing-definition ranges computed from the AST (the tool already parses source), or fall back to "file changed but no symbol attributed — N definitions in file" as an explicit gate note instead of silence.

### 1.3 "COMPILER-VERIFIED" without a working compiler check
- `runChecker` computes `ok` from exit status; `verifyCleanupPlan` (src/runtime/cleanup-verify.ts:74-93, 441-461) never reads it — batch failure is detected only by new lines matching `/\berror\b/i`. `go build` diagnostics and ruff's plural "Found 2 errors." don't match → `status:'verified'` → "COMPILER-VERIFIED" → `cleanup-apply --verified` mutates files.
- The verification worktree is `git worktree add HEAD` with only *plan-file* dirtiness disclosed (cleanup-verify.ts:69, 262-277): uncommitted or untracked source that references a deleted symbol is invisible to the check that then edits your real working tree.
- Tier-4 exists for 5 of 16 advertised languages (tsc, go, ruff/compileall, clj-kondo, cargo) — and clj-kondo is a linter yet earns the same "COMPILER-VERIFIED" banner (handlers.ts:584). Java/Kotlin/Scala/Ruby/C#/C-C++/PHP/Dart/VB have no tier-4 at all.
- `verifyCleanupPlan` orchestration has zero end-to-end tests.
- Fix: fail any batch whose checker exits nonzero with no parsed errors; disclose worktree scope; rename the banner per-oracle ("clj-kondo-verified").

### 1.4 The reuse detectors can't see the canonical rot
- Ground truth in this repo: `escapeRegex` ×7 + `escapeRegExp` ×3, near-identical one-line bodies (plus `normalizePath` ×4, `compareProfiles` ×5).
- `similar escapeRegex`: one 50% match to an unrelated function — similarity is *callee-fingerprint*-based, and tiny helpers have no callees. `recent-duplicates`: nothing (100-commit window; these are established). `similar-signatures`: lists them, but inside a giant "(string)→string" cluster mixing 3-LOC and 56-LOC functions. `health`: 97/100.
- Separately, `recent-duplicates` directionality breaks on renames: file age comes from `git log --diff-filter=A` with no rename detection (src/analysis/git-history.ts:382-390), so after a `git mv` the *original* is labeled the ECHO with a directive to delete it — with no runtime heuristic disclaimer (§5).
- Fix: add a token/AST-hash duplicate detector for small bodies (the case is trivially detectable — the bodies are near-identical text); make `similar-signatures` cluster by size band; rename-aware ages via the `detectRenamedFiles` machinery diff-impact already has.

### 1.5 Quiet coverage degradation where agents can't see it
- `commandAnalysisBudget` (src/runtime/cli-support.ts:87-111) caps scans and disables semantic enrichment on large indexes; the disclosure goes to stderr and is suppressed exactly when `--json` or hook mode is active (impact.ts:199-201). A CI/hook diff-gate pass on a big repo is a reduced-coverage pass with no trace in the payload.
- Suppression IDs hash the full match-set (diff-gate.ts:404-409, 872-879): any new similar function anywhere changes the ID and silently un-suppresses an accepted finding. Baseline identities break on file *or symbol* rename. Neither behavior is documented or tested.
- self-audit skips every sample where the oracle found zero refs (self-audit.ts:105) — "precision 1.0" is computed only on symbols where hallucination is least likely, and it audits a non-default code path (not the `findReferences`-first path production `refs` uses).

---

## 2. The TLA+ subsystem (user-flagged deep dive)

Full analysis + redesign in the [companion proposal](2026-07-01-tla-redesign-proposal.md). The findings:

- **What it checks**: mapping JSON validity; mapped names appear in the `.tla` text (regex parse — `VARIABLES` lines and `name ==`, not SANY); referents resolve in the index (first-match, §1.1's ambiguity bug applies); a name/alias-based static write scan; declared `calls` ⊆ SCIP call graph; hand-authored trace JSON keys ⊆ declared writes. TLC/SANY/Apalache check the model *in isolation*.
- **Mutation test A (this session)**: swapping two actions' `code` referents — binding TLA actions to the wrong functions — **passes, exit 0**, with the banner "PASS: model, mapping, and checked code evidence agree."
- **Mutation test B**: stripping `allowUnknown` from the shipped dogfood mapping makes it fail (exit 1). The shipped spec passes only by opting all five actions out of the one check with teeth, and by mapping every "variable" to a TypeScript **interface** (a category error the checker accepts) — hence its own summary line: `0 modeled write(s)`.
- `reads` are parsed, validated for name-existence, and **never checked against code**. The mapping's `invariants` array is never consulted. The plan doc's promised `change-graph` evidence tier and "trace not accepted by the next-state relation" check (docs/plans/2026-07-01-tla-model-conformance.md, Goal) were not implemented. There is no runtime trace *producer* — trace JSON is hand-written by the same author being checked.
- No tla2tools.jar is bundled/fetched; default runs on a normal machine skip the model checker (correctly exiting 1, but with no path to success). The dogfood model itself is a 5-state linear pipeline whose invariants are ordering truisms — it cannot meaningfully fail, which is the anti-pattern the skill should warn against.
- The `tla <operation> <spec>` grammar supports exactly one operation.

Verdict: today it is a mapping-freshness linter plus an optional off-the-shelf model check; nothing connects model semantics to code semantics. The proposal lays out the fix in three pillars (evidence-derived scaffolding; execution-trace validation against the next-state relation; effect-based static conformance) plus a skill that actually teaches model quality.

---

## 3. Adoption, hooks, and consent (highest blast radius)

### 3.1 Install-time behavior
- **[high]** postinstall (package.json:299 → src/runtime/setup.ts:122-144) runs on every npm install — including as a transitive dep — writing symlinks into `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, and can invoke `brew install` / `go install …@latest` (src/runtime/scip-cli.ts:164-212; 300s, network, unpinned). `|| true` hides all failures.
- **[high]** `SCIP_RELEASE_URL = github.com/scip-code/scip` (scip-cli.ts:9) vs brew/go installs from `sourcegraph/scip` — the printed manual-download URL points at a different org than the package-manager paths.
- **[high]** Skill symlinks point into whatever copy ran the install: npx cache → dangling; per-project node_modules → last-install-wins globally; global upgrade → skill content changes under the agent silently. No `uninstall` command exists. 22 skills' descriptions land in **every** session of **every** repo — a permanent prompt-token tax on unrelated projects.

### 3.2 Per-prompt costs
- **[high]** `refreshIndexForHookIfNeeded` runs on UserPromptSubmit (src/runtime/agent-hooks.ts:396-454): freshness = SHA-256 of every tracked+untracked file, per prompt; stale (i.e., any edit — the normal state) → synchronous reindex before the prompt proceeds; on big repos that exceeds the 60s hook timeout and retries every prompt. SessionStart fingerprints twice (:430, :461).
- **[high]** Hook-triggered reindex runs without `skipAutoInstall` — submitting a chat message can invoke `brew`, `go install`, or `npm install -g scip-python-plus` (src/reindex/index.ts:453-466, 581-582).
- **[high]** Hooks are written to the checked-in `.claude/settings.json` (agent-hooks.ts:128-135) with a bare PATH-resolved `scip-query` command — every teammate executes whatever `scip-query` is first on their PATH on session start, every prompt, and every stop; teammates without it get three failing hooks per turn. No `--no-hooks` flag on setup; re-running setup re-adds hooks a teammate deliberately removed.

### 3.3 The keyword router
- `renderUserPromptContext` (agent-hooks.ts:485-540) substring-matches ~40 keywords over 7 categories: `'wrong'`, `'fix'`, `'review'`, `'install'` (matches "reinstall"), `'score'` (matches "underscore"), `'bug'` (matches "debug"). Observed live: one review-request prompt triggered debug + review + setup routes simultaneously — ~200 injected tokens, every prompt, no config/env off switch (only deleting the hook). It duplicates work the AGENTS.md block and skill descriptions already do natively.

### 3.4 Stop hook
- Default "warn" mode runs the full diff-gate on every Stop in a dirty tree and emits only `systemMessage` — a UI string the model cannot act on (agent-hooks.ts:347-386). The gate also runs against whatever index existed before the turn's edits — stale by construction — while the tool's own AGENTS.md prescribes `reindex && diff-gate`. Meanwhile `src/runtime/agent-setup.ts:1-17` still contains the header declaring this module "deliberately does NOT write any tool's hook config" — a philosophy the codebase now violates without having deleted it.

### 3.5 Misc
- Health dossier force-written into the user's `docs/` tree with machine-local absolute paths and a fresh timestamp (guaranteed git noise; the committed one leaks `/Users/aydansalois/...`).
- setup-ci workflow: npm-only, no indexer install, unpinned `npx scip-query` (registry-latest execution in CI), no index caching.
- Five overlapping diagnostics (`capabilities` ≡ `capability-matrix` share one implementation; `doctor`/`status`/`check-deps` overlap); `doctor` exits 1 on a merely-stale index — the normal mid-edit state.
- `config-validate` accepts unknown keys silently (`"autoRefres": true` passes); `watch.enabled` is written by `init` and read by nothing.

---

## 4. Documentation vs reality

False or broken claims (each verified):
- **[high]** README:252 `npm install -g scip-clojure` — E404; the headline Clojure install path fails for everyone.
- **[high]** README:167 "config-validate rejects suppressions without an identity and reason" — false; reason + (id **or** check) passes (src/runtime/config.ts:240), and this repo's own id-less `check:"echo"` entry validates clean while waiving *all* echo findings in that file, unbounded.
- **[high]** README:152 + AI_FAILURE_MODES.md:239 put "baseline regressions" in the gate — `includeBaseline = false` by default (diff-gate.ts:183); the live `checksRun` list confirms.
- **[high]** README indexer links for scip-dart and scip-php 404 (wrong owner).
- **[med]** "safe to delete"/"Zero risk" language in `dead` output, health actions, and AGENT_GUIDE for tier-1 findings, directly contradicting README:202's "compiler verification is the only tier that earns the word 'safe'."
- **[med]** DETECTOR_GUIDE "diff-gate runs all three [drift] angles" — it runs two. API.md "every CLI command is also available as a TypeScript function" — ~a dozen aren't. README `init` example shows config `init` doesn't write. Shipped health dossier claims 100/100 (June 27) vs 97 now; analyzer-inventory "currently reports" stale numbers. `docs/plans/` linked from the published README but not shipped in the tarball. scip-language-playbook omits Go and Clojure that the code supports.
- The diff-gate check list is stated in four places with three different contents; only the generated COMMAND_REFERENCE is right.
- **Verified true** (credit): all four README heuristic guardrails exist precisely as claimed; the JSON envelope holds across 10 diverse commands; COMMAND_REFERENCE is byte-current; package exports are 61-for-61; API.md example code runs as written.

---

## 5. Output honesty and agent ergonomics

- Two disconnected labeling mechanisms: the runtime disclaimer (`renderHeuristicNotice`) and the docs-only `descriptor.heuristic` flag. **recent-duplicates, doc-drift, incomplete-migration, co-change, diff-gate** carry no runtime disclaimer; `similar-signatures` is flagged by neither; recent-duplicates/unused-params/similar-signatures/dead/isolated ship `--json` with no evidence-tier field at all. One choke point should force every finding to carry its tier to both humans and JSON.
- Volume: `dead` with no scope prints 1,367 lines (1,088 file-internal symbols) at an agent. Uncapped-by-default was a deliberate choice with honest `skipped[]` disclosure — but human-mode output needs summarize-then-drill ergonomics, not a full dump.
- Inconsistent target domains: `plan-context`/`trace` reject non-indexed files (a one-line shrug for the .md files the tool's own workflow edits — no git-history fallback, though co-change/doc-drift happily analyze those same files). An agent cannot predict which commands accept which targets.
- `co-change`'s file mode prints partners tagged `[dep edge]` under a command whose description is "…**without** a dependency edge" — the honest behavior (declared couplings still shown) reads as a self-contradiction without a note.
- Health "Risk" is asserted, not derived: DEDUCTION_KIND hardcodes risk-vs-hygiene; the genuinely-computed validation lift never feeds classification or weights. Fix-commit identification is an undisclosed subject-line regex.

## 6. Skills (23 bundled + 3 repo-local)

- **Command-surface accuracy is 100%** — every one of ~140 `scip-query` invocations across 26 SKILL.md files is a real command with real flags. This is the metric that matters most for agent consumers, and it's clean (and the BUILTIN_SKILLS↔directory lockstep is test-enforced).
- **[high]** `scip-adoption` vs `scip-query-setup`: the same workflow shipped twice; the router's own route table lists both for one row and its tie-breaks skip the pair. Merge them.
- **[med]** `scip-health-audit`/`scip-health-improve` frontmatter both claim "after setup" and "perfect code" — a coin flip at cold selection.
- **[med]** Systemic double-gating: the router loop, scip-debug, scip-api-impact, and scip-triage-issue all run postchecks + `diff-gate` inline **and** invoke `scip-verify`, which reruns both — doubling the most expensive closeout in every workflow.
- **[med]** `concrete-plan` step 5 ends with `diff-impact --json` at planning time — there is no code diff yet; the flagship skill's verification step is a no-op ritual.
- **[med]** `.agents/skills/typescript/AGENTS.md` links `references/_sections.md` nine times; the file doesn't exist — in the repo that ships a doc-drift detector, and despite the rewrite plan checking off "every relative Markdown pointer resolves."
- **[med]** `skills/_shared/SKILL.md:48-143` hand-duplicates ~60 command lines that are descriptor-generated elsewhere; currently in sync, structurally guaranteed to drift. Generate it.
- Assorted: `similar <new-function-name>` taught as a pre-write check (can never match a symbol that doesn't exist); `health --write-baseline` immediately followed by `health --baseline` (trivially passes); `health --full` (documented no-op) taught in six skills; `_shared` examples cite symbols from a different private codebase (`processVegaMention`, `ChatService`); dev-repo vocabulary ("command descriptors") in a shipped skill; README's skill enumeration omits two shipped skills; repo-local maintainability skills triple-overlap the shipped one.
- **Structural critique**: five cleanup-family skills are one workflow wearing five costumes (the real axes are audit-vs-act and scope); a router needing a seven-rule tie-break appendix is evidence the boundaries don't carve at joints. ~12 skills would serve the same promise with near-deterministic cold picks. Glossaries defining "function" and "pure function" to a frontier model are pure token sediment (concrete-plan is 2.3× median length largely for this). Skills write artifacts to five different output roots.

## 7. What is genuinely good (calibration)

- The repo's own gates pass: 490/490 tests (real assertions, no snapshot vibes), typecheck, lint. Reindex is properly engineered (lockfile, atomic publish, shard reuse). evidence.db caching is well tested.
- `plan-context` on a real symbol is excellent agent output — ten structured sections from definition to history in 160 lines.
- The honesty machinery mostly exists and is real where wired: itemized health deductions, computed per-detector validation lift, suppressions with required reasons and enforced expiry, uncapped defaults with explicit `skipped[]`, four verified README guardrails, byte-current generated command reference, 61/61 exports, clean JSON envelope.
- The skill rewrite's discipline ("complete only when…" criteria, ~2,300 lines removed, zero command-surface errors) is rare in agent-skill packages.
- AGENTS.md managed blocks, refusal to clobber foreign pre-commit hooks, idempotent hook merging, and the optionalDependencies degradation rationale show real care.

## 8. Priority shortlist

| # | Fix | Effort |
|---|---|---|
| 1 | Disclose/resolve ambiguous symbol matches; nonzero or `matched:false` on no-match | S |
| 2 | Read the `ok` flag in cleanup-verify; fail unparsed nonzero exits | S |
| 3 | Attribute initializer-body edits to their enclosing symbol in diff-impact | M |
| 4 | Gate postinstall side effects behind explicit setup; fix the `scip-code` URL; add `uninstall` | S–M |
| 5 | Never reindex or auto-install from UserPromptSubmit; mtime-based staleness; hooks → `settings.local.json` (or ask) | M |
| 6 | Delete or word-boundary+dedupe the keyword router; default Stop hook to `feedback` mode | S |
| 7 | One labeling choke point: every finding carries its evidence tier in human + JSON output; kill "safe to delete" outside tier-4 | M |
| 8 | Small-body duplicate detector (token-hash) so the tool can catch its own escapeRegex×10 | M |
| 9 | Fix the five false README claims (§4 high) | S |
| 10 | Merge adoption/setup skills; collapse the cleanup family; single closeout via scip-verify | M |
| 11 | TLA P0: verify `reads`, reject type-referents, per-fact waivers, honest PASS text, bundle tla2tools (see proposal) | M |
| 12 | Surface analysis-budget degradation in JSON/hook payloads | S |
