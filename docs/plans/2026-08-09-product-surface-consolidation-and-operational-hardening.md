# Product surface consolidation and operational hardening

Date: 2026-08-09

Status: implementation and validation complete; release blocked by the held accuracy/token gate

## Outcome

scip-query presents one coherent product to an agent: a small setup workflow, one general repository-exploration skill, and one evidence-backed planning skill. The indexed exploration surface remains accurate within explicit coverage, ordinary edits use incremental TypeScript indexing whenever the changed inputs permit it, health detectors consume typed evidence only where that evidence can support their claims, and advanced formal-modeling features do not crowd the ordinary navigation surface.

The program is complete only when the implementation, installed skills, generated guidance, CLI help, tests, operational telemetry, package, and benchmark evidence agree about that product.

## Essential concepts

An **exploration surface** is an interface through which an agent observes a repository. What distinguishes it from a text reader is that it joins current source text to compiler-owned identities, typed relationships, calibrated coverage, and exact source recovery, allowing the agent to choose what fact to establish without inventing relationships from file proximity.

An **incremental index update** is an index publication derived from the previous valid generation plus only the source units whose compiler meaning can have changed. Its defining cause is reuse of the unaffected generation; a command that regenerates every TypeScript document after one ordinary source edit is a full rebuild even if publication itself reuses files through reflinks.

A **typed evidence contract** is a machine-readable statement of what a detector or command may conclude from a named relationship provider. It differs from a generic graph dependency because it states the relationship, evidence strength, coverage limit, non-claims, and recovery path that make a conclusion valid.

A **health detector** is an analysis that reports a repository condition a maintainer may act on. Its defining requirement is an inspectable claim with calibrated evidence; a heuristic lead is not a confirmed defect merely because it appears in a composite score.

A **compatibility shell** is a deliberately thin retained interface that forwards an old public name or invocation to its replacement during a bounded transition. It preserves existing consumers without preserving the obsolete internal mechanism.

## Frozen evidence

### Agent exploration baseline

The accepted matched corpus contains eight treatment/control pairs: six `gpt-5.6-luna` max-reasoning pairs and two `gpt-5.6-sol` medium-reasoning pairs. The source record is `docs/benchmarks/2026-08-09-exploration-surface-calibration-results.md`.

| Scope | Total-token mean | Total-token median | Weighted total saving | Uncached-input mean | Rendered-evidence mean | Strict facts, treatment/control |
|---|---:|---:|---:|---:|---:|---:|
| Luna, 6 pairs | 32.8% | 38.9% | 33.4% | 33.8% | 59.0% | 14 / 12 |
| Sol, 2 pairs | 12.8% | 12.8% | 8.4% | 11.6% | 32.3% | 9 / 7 |
| Combined, 8 pairs | 27.8% | 28.0% | 31.1% | 28.2% | 52.3% | 23 / 19 |

Cached model input cannot be isolated from these records. Total tokens include cached input and output; uncached input is recorded independently. No later report may claim a separate cached-input saving from this corpus.

The accuracy scope is limited to the fixed repositories, commits, prompts, models, and strict compound-fact rubric. One Luna Rust treatment used 7.0% more total tokens while rendering 60.5% less evidence, and one held meta-harness pair lost one strict fact. The corpus establishes promising compression with aggregate non-inferiority, not arbitrary-task dominance.

### Skill baseline

`scip-query install-skills` currently distributes exactly:

- `scip-query`, which teaches command mechanics;
- `scip-explore`, which teaches the evidence ledger and answer audit;
- `concrete-plan`, which teaches planning but still contains obsolete `context` and under-specified `evidence <symbol>` examples.

The two exploration skills describe one ordinary workflow and can be loaded independently, which permits incomplete instruction. Generated repository guidance explicitly requires both. The `.agents/skills` directory contains repository-maintenance aids and is not part of the distributed product surface.

### Setup, suppression, and health baseline

- `suppress` validates explicit adjudication evidence, opens the index for an observation receipt, and writes one revision-aware record. It does not run health.
- Three safe no-write probes completed in 0.29–0.30 seconds.
- A bounded `health` run on scip-query completed in 5.9 seconds and returned a valid report.
- `setup` runs the optional full health audit unless `--no-health` is passed. Index setup and repository-quality auditing are therefore coupled by default.
- Health owns 22 phases and calls existing detector modules independently. The composite does not consume the graph-relation provider registry as a shared evidence contract.

### Graph and CFG baseline

The TypeScript local-flow provider builds callable-local control-flow nodes, reaching definitions, postdominators, control-dependence edges, bounded field flow, and candidate closure captures. It feeds `value-flow`, `dependence-slice`, and typed graph evidence. Runtime-boundary joins feed navigation graph construction. The newer CFG and runtime relationships are not generally consumed by cleanup detectors.

Focused validation before this program passed 69/69 tests across TLA conformance, TypeScript local flow, suppression storage/adjudication/inventory, health full behavior, health report generation, and health caching.

### Indexing and cache baseline

The eight-cycle disposable-worktree soak proves a one-file incremental path and a stable managed-byte plateau. Current live state is also bounded on disk at approximately 236 MB shared and 118 MB local.

The current checkout's prior 24-hour telemetry nevertheless recorded:

- 211 refresh runs;
- 160 TypeScript rebuilds;
- 139 demand-triggered TypeScript rebuilds;
- approximately 4.9 GB of newly generated TypeScript SCIP output;
- a median rebuilt-run duration of approximately 9.7 seconds.

The latest full-project shadow fallback was justified by a changed `.scipquery.json`, but the aggregate telemetry does not establish that the demand path uses incremental updates reliably during ordinary editing. Reflinked publication and bounded retained bytes do not excuse unnecessary compiler regeneration.

### TLA baseline

The TLA+ feature is live: seven implementation modules, seven dedicated test files, and public `verify`, `scaffold`, `instrument`, `trace-check`, and `fetch-tools` operations. Its conformance suite passes. Several checked-in models still describe retired diff-gate and finding-outcome-ledger systems. TLA+ does not contribute to the ordinary indexed-exploration loop and currently occupies a top-level default-help panel.

## Public behavior to preserve

- Existing primary exploration commands and their JSON contracts.
- Explicit evidence families, strengths, coverage, recovery, and continuation behavior.
- Existing installed skill names during a documented transition when removal would strand configured agents.
- Existing specialized command invocations unless a versioned breaking release or compatibility shell is supplied.
- Suppression record schema, revision conflicts, evidence requirements, and invalidation behavior.
- Bounded and full health modes as explicit user choices.
- TLA command behavior while it remains shipped, even if it moves out of default help.
- Worktree-local cache ownership, shared immutable baselines, generation retention, and safe cleanup.

## Explicit non-goals

- Do not make scip-query infer English task relevance.
- Do not reintroduce anchor ranking, query caps, or automatic route selection.
- Do not inject every graph edge into every detector.
- Do not count detector quantity or health-score movement as proof of improved quality.
- Do not remove TLA merely because it is outside the core mission; first separate visibility, stale artifacts, usage, and compatibility.
- Do not claim universal token or accuracy improvement from the frozen corpus.

## Role inventory and disposition

| Role | Current referents | Pressure | Disposition |
|---|---|---|---|
| General exploration | `scip-query`, `scip-explore`, generated AGENTS guidance | One workflow split across two independently triggered skills | Merge into one canonical `scip-query` exploration skill; keep `scip-explore` only as a bounded compatibility shell if required |
| Planning | `concrete-plan` | Obsolete commands and terminology | Replace with canonical `scip-plan`; preserve or remove the old name according to the skill transition contract |
| Setup and repair | CLI `setup`, `doctor`, `status`, `watch`, `install-skills`; no focused skill | Lifecycle guidance is mixed into normal exploration | Add a small `scip-setup` skill activated only for installation, indexing, cache, and watch work |
| Health during setup | `runProjectSetup`, `runSetupHealth` | Full audit delays the exploration-ready outcome | Make health opt-in and report the separate command clearly |
| Suppression | `handleSuppress`, suppression writer/store | Historical latency belief obscures the current narrow path | Keep mechanism; document and test that it does not invoke health or rebuild unnecessarily |
| Incremental TypeScript indexing | fragment store, update service, affected-set planner, demand freshness path | Controlled patching exists but live demand telemetry rebuilds frequently | Instrument decisions, reproduce one avoidable full rebuild, route eligible edits through the patch path, and prove fallback safety |
| Health evidence | 22 phase runners and independent detectors | New typed providers do not constrain applicable findings | Add detector evidence requirements and share typed providers selectively |
| Formal modeling | top-level `tla` command, TLA modules, checked-in specs | Correct but non-core; stale retired-system models | Move to advanced visibility, remove stale artifacts after reference/API proof, retain command compatibility |
| Specialized command inventory | default grouped help and registered aliases | Too much visible cockpit surface | Keep executable aliases, narrow default orientation, expose the complete inventory through advanced help/capabilities |

## Implementation phases

### Phase 1 — Freeze compatibility and product descriptors

1. Characterize installed skill directories, generated guidance, setup defaults, command panels, JSON/help snapshots, suppression execution, health modes, TLA commands, and reindex decision records.
2. Define the new canonical skill IDs and the transition behavior for old directories and explicit invocations.
3. Add failing contract tests before changing generated surfaces.

Proof: old supported invocations either remain functional or receive a documented versioned retirement; generated text is derived from one descriptor source.

### Phase 2 — Consolidate the agent skill surface

1. Make `scip-query` own the complete general exploration loop: material claims, exact location, explicit relationship choice, coverage-led recovery, source inspection, answer audit, and stopping condition.
2. Create `scip-plan` using only current primary controls and explicit relationship syntax.
3. Create `scip-setup` for installation, setup, doctor, status, watch, cache ownership, freshness, and cleanup.
4. Remove duplicated prose and update `BUILTIN_SKILLS`, installer/uninstaller behavior, agent metadata, generated AGENTS/CLAUDE guidance, command docs, and link checks.
5. Preserve old skill names only as thin redirecting compatibility shells if an installed-agent transition requires them.

Proof: a fresh installation exposes the intended canonical skills, stale installed copies are removed or redirected deterministically, and no canonical skill teaches a compatibility/deprecated navigation path.

### Phase 3 — Separate setup from repository auditing

1. Change setup so the recommended/default path installs dependencies and skills, writes guidance, refreshes the index, and stops after readiness.
2. Replace default full health with explicit `--health`; retain `--no-health` compatibility without ambiguous precedence.
3. Update interactive prompts, JSON results, documentation, tests, and setup timing evidence.
4. Add a suppression command contract proving that suppression does not invoke health and does not require a full reindex when the current observation receipt is available.

Proof: default setup reaches exploration readiness without health phases; explicit health still produces the same report; suppression remains revision-safe and bounded.

### Phase 4 — Close the demand reindex gap

1. Add decision telemetry that distinguishes compiler regeneration, incremental fragment update, unchanged reuse, SQLite patching, and immutable-generation publication.
2. Build a real command-driven reproduction from a stable indexed checkout: edit one ordinary TypeScript implementation, allow the debounce interval, invoke a freshness-requiring exploration command, and observe whether the TypeScript index is regenerated.
3. Trace backward from an observed avoidable rebuild through freshness, affected-set, TypeScript project identity, fragment availability, and service readiness.
4. Change exactly the decision that prevents eligible patching. Preserve full rebuilds for configuration, ambient declarations, file addition/deletion, unavailable dependency graphs, unsupported project layouts, and failed/incomplete incremental products.
5. Prove causation by demonstrating failure before the fix, success with it, failure when the change is reverted in an isolated experiment, and success after reapplication.

Proof: repeated command-driven one-file edits patch the eligible TypeScript project without full SCIP regeneration, while every preregistered unsafe input still forces a full rebuild. Cache generations plateau and deleted worktrees age out.

### Phase 5 — Give detectors typed evidence contracts

1. Add a detector contract declaring claim, required relation families/subtypes, minimum evidence strength, provider coverage, non-claims, and source-recovery command.
2. Adapt detectors by conceptual need:
   - dead, isolated, and reachable-stub analyses consume entry, execution, runtime-registration, identity, and disclosed reflection/generated-dispatch gaps;
   - wrapper, passthrough, and stale-abstraction analyses consume execution, ownership, contract, and consumer evidence;
   - complexity and decorative-checker analyses consume local CFG/control-dependence and terminal behavior where supported;
   - duplicate/similarity analyses remain structural and use graph evidence only as corroboration.
3. Surface exact, derived, candidate, mixed, and unsupported coverage in health results instead of upgrading candidates into defects.
4. Generate detector documentation and contract tests from the same descriptors.

Proof: curated positive and negative corpora show improved precision or strictly stronger disclosed coverage without losing calibrated positives. Unsupported provider cases remain unknown rather than negative.

### Phase 6 — Demote advanced surfaces and retire stale artifacts

1. Keep the six primary exploration controls visually dominant in default help and skills.
2. Move specialized analyses, cleanup inventory, and TLA+ to clearly labeled advanced discovery without removing supported command aliases.
3. Audit TLA models against current owners. Remove retired diff-gate and finding-outcome-ledger models only after references, docs, package contents, and public contracts prove they are artifacts rather than active compatibility fixtures.
4. Preserve the working TLA implementation and focused tests unless usage and maintenance evidence justify a separately approved extraction or retirement.

Proof: default help is materially smaller, `--help-all` remains complete, old command invocations still work, package contents contain no unowned retired-system models, and TLA focused tests pass.

### Phase 7 — Final proof and benchmark

Run, on the exact final tree:

- formatting, ESLint, all TypeScript fixture typechecks, build, declaration generation, API manifest, public consumer, skill links, architecture, and full tests with bounded concurrency;
- skill installation/uninstallation smoke tests in clean temporary roots;
- default and explicit-health setup smoke/timing tests;
- suppression latency and no-health/no-reindex contract tests;
- incremental command-driven edit soak, configuration/ambient/add/delete fallback cases, worktree fork/cleanup plateau, and cache-retention checks;
- TLA focused suite and packaged help/command smoke tests;
- matched treatment/control agent runs across at least one TypeScript and one non-TypeScript task for both an open-ended and a specific prompt shape.

Record per pair: strict material facts, total tokens, uncached input, output when available, rendered evidence, exploration calls, native reads, index setup outside the model turn, agent wall time, failures/retries, and cleanup. Report every pair; do not average away a losing fact set.

## Completion gates

- The canonical installed surface is setup, planning, and general exploration, with no duplicated mandatory exploration skill.
- Every canonical skill and generated instruction uses current commands and explicit evidence-family controls.
- Default setup does not run full health.
- A one-file eligible TypeScript edit followed by an exploration command does not regenerate the complete TypeScript SCIP index.
- Full rebuild fallbacks remain correct and explicitly explained.
- Applicable health findings expose typed evidence and provider coverage; unrelated detectors are not graph-washed.
- Default help is smaller while compatibility aliases and `--help-all` remain functional.
- Retired TLA artifacts have an explicit keep/remove decision and no stale ownership ambiguity.
- Final tests, package smoke tests, operational soaks, and benchmark records pass from the exact committed tree.

## Deferred register

Nothing is deferred at program start. A later deferral must name the verified blocking fact, the affected public behavior, and the condition that permits resumption.
