# Detector precision, diff-gate, and the event ledger

## Weight findings by measured precision, not volume

Detector precision was calibrated against two external production repos on 2026-07-01 (`docs/validation/2026-07-01-external-calibration-*.md`). Use that calibration to decide how much a finding is worth acting on alone versus needing corroboration.

**Strong signal — act on directly:**
- `complexity-hotspots` (~90% precision)
- `recent-duplicates` (~75% precision)
- Graph facts from `refs`, `trace`, `deps`
- Compiler-verified `cleanup-plan --verify` output

**Good with review — read the cited code before acting:**
- `duplicate-bodies`, `similar`, `co-change`, `doc-drift`, `twin-drift` (post-retune defaults)

**Exploration only — near-zero precision on codebases with intentional layering or ambient types:**
- `wrapper-candidates`, `stale-abstractions`, `drift --patterns`

Never file a finding from an exploration-only detector without reading the cited code first. `convergence <s1> <s2>` and `capability-matrix` are deprecated aliases (`similar <s1> <s2> --plan` and `capabilities --matrix` respectively) — prefer the modern form.

## diff-gate

`diff-gate` gates the current diff for architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates, and exits 1 on blocking findings. It recognizes ten checks, any of which can be skipped individually with `--skip <check>`:

| Check | Flags |
|---|---|
| `echo` | recent-duplicate-style echoes in the diff |
| `incomplete-migration` | partially-completed extractions left in the diff |
| `co-change-partner` | a missing historically-paired file |
| `twin-partner` | an unedited same-name twin — **advisory**, never blocks |
| `coverage-contract` | a configured `coverageContracts` enumeration drifted from ground truth (see `scip-setup`) |
| `architecture` | a declared boundary violation absent from the shared baseline |
| `doc-reference` | an uncited or stale doc claim |
| `unused-params` | trailing parameters no body uses |
| `new-dead` | dead code introduced by this diff |
| `baseline` | only active with `--baseline`; compares all non-architecture health identities against `.scipquery-baseline.json` — distinct from `health --baseline` |

The `architecture` check runs by default only when enforceable architecture rules and a baseline exist, and it reads that baseline file directly without running the full health suite.

**Reading grouped output:** findings print grouped under a `Root-cause groups (N):` header before the flat list. A root-cause group's remediation usually clears every finding under it. The same remediation may repeat afterward in the flat list below the groups — that repetition is expected, not a separate issue.

**actionTier** on baseline-backed findings tells you how directly to act:
- `direct` — act on this finding alone.
- `signal` — corroborating evidence; read before acting.
- `support` — context only.

Findings marked `(advisory)` never block; treat them as context, not obligations. Fix every finding, or record a specific acceptance reason for each one left unresolved — never report success while a finding is unexplained.

## Event ledger

Every completed diff-gate run — including JSON and hook mode — writes each caught/resolved/suppressed transition to its own committed `.scipquery/events/*.json` file. Independent branches should add independent event files rather than editing a shared log, and commit them with the corresponding change. Legacy `.scipquery/ledger/events.jsonl` records remain readable and migrate automatically on the next gate write.

## Effectiveness

`scip-query effectiveness [--since 30d] [--check <check>]` reports, per check: findings caught, comparison-verified fixed, suppressed, still open, "moved" (rename noise), legacy/non-comparable "unverified" resolutions, precision (verified-fixed ÷ (verified-fixed + suppressed)), and median days-to-fix.

A pre-commit rerun of diff-gate reuses the same comparison base directly. After HEAD advances, a clean diff-gate run automatically replays the stored comparison commit. A dirty or unavailable replay leaves the effectiveness finding pending instead of manufacturing a fix result. Standalone detector commands (outside diff-gate) are not outcome-tracked in this ledger until they expose complete-scan evidence.

When `diff-gate --hook` reports that a check is rarely acted on in this repo: tune that check's config, suppress the standing findings with reasons, or consciously accept the noise. Do not let unresolved findings accumulate as wallpaper.
