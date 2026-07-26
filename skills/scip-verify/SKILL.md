---
name: scip-verify
description: Use after finishing a change and before committing: ensure the watcher has produced a fresh index generation, run the postchecks matching what you edited, diff-gate, and try to refute your own PASS — including verifying that a React or Vue refactor actually achieved the reuse it claimed. Also use to calibrate detector precision once a repo is already set up and its findings look too noisy or too clean. For an existing status claim with no just-finished diff, use scip-audit instead. Distinct from the `review` skill: that one reviews a branch against coding standards and the originating spec; this one runs freshness, routed postchecks and diff-gate checks on a change you just made.
commands:
  - template: "scip-query doctor"
    when: "Prove the workspace and configuration are usable before trusting evidence."
  - template: "scip-query diff-impact --json"
    when: "Compare changed files, symbols, and affected consumers with the intended diff."
  - template: "scip-query diff-gate --json --compact"
    when: "Run the complete finished-diff gate without blind line truncation."
---

# scip-verify

## Purpose

Verification is the evidence pass that proves a finished change is wired,
safe, and regression-free: the workspace can answer, the index is current,
the changed symbols and files match intent, every postcheck the edit calls
for ran, and diff-gate findings are resolved. A PASS is the verdict nobody
re-checks, so the flow below ends by trying to break it before it's claimed.

Calibration is the companion problem: a detector tuned on one codebase's
conventions can be precise there and noisy elsewhere, so before any of the
above output is trusted on a repo, someone has to find out which it is.

Load shared mechanics — command syntax, the evidence contract, diff-gate's

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query doctor` | Diagnose config, index freshness, dependency readiness, and project capabilities | config, freshness, dependency, and capability diagnostics | `complete` | Prove the workspace and configuration are usable before trusting evidence. |
| `scip-query diff-impact --json` | Compute changed symbols and downstream consumers from current git diff | changed symbols, downstream consumer identities, and impact paths | `bounded` | Compare changed files, symbols, and affected consumers with the intended diff. |
| `scip-query diff-gate --json --compact` | Runtime-bounded, single-flight gate for the current diff: architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates; exit 1 on blocking findings | blocking findings with check id, message, and remediation; advisory findings; root-cause groups; changed file and symbol counts; process exit status (1 when blocking findings exist) | `bounded` | Run the complete finished-diff gate without blind line truncation. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->
ten checks, detector-precision tiers — from `_shared`. This skill's own
shortlist covers `doctor`, `status`, `diff-impact`, `diff-gate`, `health`,
`doc-drift`, `self-audit`, `suppress`, and `config-validate`.

| Situation | Go to |
| --- | --- |
| You just finished editing and need to verify it before committing | Verify a finished change, below |
| Findings on this repo feel too noisy, too clean, or you're adopting scip-query in a new repo | [`references/calibrate-detectors.md`](references/calibrate-detectors.md) |

## Verify a finished change

### 1. Prove the workspace

```bash
scip-query doctor
scip-query status --capabilities
```

Apply `_shared`'s freshness gate here: if the watcher is already refreshing or
has accepted a refresh request, wait and check once more rather than launching
a parallel reindex. Use manual `scip-query reindex` only when the index is
stale, missing, or unknown and the watcher is disabled, unavailable, or failed.

Complete only when missing indexers, invalid config, stale indexes, or
unavailable relevant capabilities are fixed or reported as blockers. Verify
environment and index freshness before trusting any graph fact that follows.

### 2. Assess the diff

```bash
scip-query diff-impact --json
```

Compare changed files, changed symbols, and downstream consumers against the
intended work. An unexpected blast radius is itself a finding even if every
later gate passes. Complete only when the diff's shape is understood.

### 3. Run routed postchecks

Run every row that matches what the diff actually did — not only the check
you expected to need going in:

| Change made | Check |
| --- | --- |
| Extracted a helper or abstraction | `scip-query incomplete-migration` |
| Added a helper, module, component, hook, composable, or adapter | `scip-query recent-duplicates` (and `similar <symbol>`) |
| Added parameters, options, props, config flags, or option objects | `scip-query unused-params` |
| Added a wrapper, facade, forwarding layer, alias, or re-export | `scip-query wrapper-candidates`, `passthrough-candidates`, `redundant-reexports` |
| Added an interface, base class, adapter contract, or type alias | `scip-query stale-abstractions` |
| Changed schema, config, generated files, public contracts, command descriptors, or docs-backed behavior | `scip-query co-change <file>` and `doc-drift` |
| Deleted code | `scip-query cleanup-plan --verify` |
| Changed React components or hooks | the React commands in `_shared` |
| Changed Vue SFCs or composables | the Vue commands in `_shared` |

Add `--json --full` to any of these when an unbounded machine-readable result
is needed rather than the bounded default. This table is authoritative — the
shared reference links here instead of duplicating it, so don't assume a
different mapping. Complete only when each applicable postcheck has a result
and every actionable finding is fixed, accepted with evidence, or blocked by
a named constraint.

If `.scipquery.json` or a suppression file changed as part of the diff, also
run:

```bash
scip-query config-validate
```

### 4. Run the gate

```bash
scip-query diff-gate --json
```

This is the primary blocker for diff-specific risk: architecture regressions
plus echo, migration, coordination, doc-drift, unused-param, and new-dead
candidates, exiting 1 on blocking findings. Fix findings or record the
acceptance reason. Prefer fixing a real finding over suppressing it — only
suppress intentional design, compatibility shims, framework entry points, or
an accepted false positive, and only with a specific reason:

```bash
scip-query suppress <id> --reason "<specific reason>"
```

`suppress` writes one file per suppression under `.scipquery/suppressions/` —
commit it with the change that produced it. Suppressing is a real decision,
not a bypass: every suppression counts against that detector's precision in
`scip-query effectiveness`. A rerun against the same resolved comparison base
earns verified credit instead; once `HEAD` advances, a clean run replays that
stored base automatically. Complete only when `diff-gate` passes or every
finding has a durable explanation.

### 5. Check health, docs, and generated surfaces when relevant

Run

```bash
scip-query health --baseline
```

when a committed baseline exists. If docs, AGENTS.md, CLAUDE.md, command
docs, generated docs, or skill instructions changed, run

```bash
scip-query doc-drift --json --full
```

and read the returned stale-doc candidates against the diff.

If the change touches generated command surfaces, detectors/analyzers, or
evidence-labeling behavior, also run

```bash
scip-query self-audit
```

It scores scip-query's own cheap evidence paths (source-fallback, regex)
against the best available semantic/compiler oracle on sampled symbols. Read
whether the surface you just changed still agrees with the oracle at the
sampled sites before trusting its output elsewhere in this flow — a
regression here means every downstream postcheck may be reading
degraded evidence, not just this one command.

Complete only when changed documentation and config surfaces are checked or
explicitly declared out of scope.

### 6. Refute the PASS

A PASS ends scrutiny, so attack it before making it. Construct at least two
refutation attempts and run the cheapest check that would expose each. Prefer
an executed probe — run the consumer's test, invoke the command, feed the
edge input — over an argued one. Pick attacks that fit the diff:

- **Unexercised consumer** — take a caller from step 2's `diff-impact` output
  whose tests did not run, and either run them or trace the contract it
  depends on.
- **Unexercised input** — find an edge the changed code newly handles or
  newly rejects, and execute it.
- **The intent gap** — find one case the stated goal implies that the diff
  does not visibly cover, then show where it's handled or show it's missing.

Record every attempt. An attempt that breaks the diff converts the verdict to
FAIL with a finding; the attempt stays in the record either way. Complete
only when every refutation attempt has an executed result.

### Report

End with this fixed template:

```markdown
Verification: PASS/FAIL — <n> postchecks, <m> refutation attempts, <k> broke

Environment:
- doctor:
- status:

Diff:
- changed files/symbols:
- unexpected blast radius:

Postchecks:
- <command>: <result>

Gate:
- `scip-query diff-gate --json`: <result>

Health/docs/self-audit:
- <commands and results>

Refutation attempts:
- R1: <attack> → survived (evidence) | broke (finding)

Remaining risk:
- <accepted findings, unavailable capabilities, or checks not run>
```

Do not claim ready-to-ship unless index freshness is `fresh` after the final
edit, `diff-gate` is passed or fully explained, and the PASS survived every
refutation attempt.

### Detector reliability for this flow

`dead`/`new-dead` correctly resolve `import type` consumers, tsconfig
`paths` aliases, pnpm/npm/yarn workspace cross-package imports, and Vue
`<script setup>` composables — these are not sources of false positives. The
one residual gap is a same-named symbol reached only through a re-exporting
barrel file in a workspace package; that shape self-labels `unconfirmed
(cross-package ambiguous-name resolution gap)` in the finding, and only that
specific label should be treated as unconfirmed until `refs` agrees.
