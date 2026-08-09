# Exploration surface calibration plan

## Outcome

Deliver scip-query as a calibrated repository instrument panel: six primary exploration controls, an explicit relationship manual, facts-first and coverage-complete readouts, no task-relevance inference, and no confidently false recovery paths. Preserve public compatibility while removing deprecated behavior from the canonical agent surface.

The complete current-state evidence and product standard are recorded in [2026-08-09-exploration-surface-audit.md](2026-08-09-exploration-surface-audit.md).

## Implementation status

- Phases 1–6 are implemented in the branch history: collision-safe sensors, non-oracle guidance, canonical command semantics, the generated cockpit manual, normalized readouts, and separated command panels.
- Phase 7 is implemented and focused validation passes. Provider contracts now reject unregistered evidence strengths at projection time; parser subtype unions are owned by the provider contract; TypeScript and Rust fixtures verify exact ownership plus partial execution/data/state/temporal ceilings and statement-complete behavior outlines; every known analyzer limit is an explicit non-lexical frontier in evidence coverage, `capabilities`, JSON, and generated documentation.
- Phase 8 is active. Final-calibration TSLint, meta-harness, OpenCode, and Rust agentic_cad treatment/control comparisons are recorded in `docs/benchmarks/2026-08-09-exploration-surface-calibration-results.md`; manual strict accuracy was non-inferior in all four, uncached input and rendered evidence fell in all four, and total tokens fell in three. The packaged false-identity collision corpus passes. Variance and final repository gates remain before this program can be called complete or release-ready.

## Current path

Repository guidance and the two exploration skills already assign objective selection and stopping to the agent (`AGENTS.md:4-35`, `skills/scip-explore/SKILL.md:8-34`, `skills/scip-query/SKILL.md:48-76`). Command descriptors already declare agent questions, result units, semantic operations, costs, gap-closing commands, coverage, and a limited set of contrasts (`src/runtime/command-kit/command-descriptor-types.ts:206-235`). `evidence` already projects explicit typed relationships (`src/runtime/query-commands/navigation.ts:1736-1885`). The implementation work is therefore consolidation and correctness repair, not a new relevance engine.

## Implementation slices

| Change | Direct evidence | Preserve | Retire | Prove |
|---|---|---|---|---|
| 1. Calibrate exact identities and call targets | Exact paths fall through to symbol text in `file-resolution.ts:60-77`; inspect leaf fallback lives in `next-anchor-candidates.ts:795-844` | Exact compiler call targets, imported-member resolution, unresolved accounting | Leaf-name recovery commands and exact-path symbol fallback | Collision fixtures for `.push()`/`.slice()` and `AGENTS.md`; focused navigation/inspection tests |
| 2. Remove oracle and proxy residue | Benchmark target/fallback in `codex-exploration-trial-core.mjs:25-41`; capability anchor line in `command-handlers.ts:1363`; planning recommendations in `planning.ts:154-174` | Evidence-driven stopping and externally measured efficiency | Agent-visible query target, anchor fallback, `READ NEXT`, relevance-sounding reuse decisions | Prompt/skill snapshots and capability-output tests contain none of the retired language |
| 3. Give canonical controls one meaning | `evidence` dispatches positional source evidence and explicit graph projection in `navigation.ts:1813-1885`; deprecated commands remain visible | Public legacy calls during deprecation window | Positional source-evidence meaning from canonical docs/help; deprecated commands from default help | Legacy compatibility tests plus graph-only canonical help and descriptor tests |
| 4. Generate the instrument manual | Descriptor semantic contracts exist in `command-descriptor-types.ts:143-235`; generated catalogue exposes only a shortlist in `generated-agent-command-catalog.ts:2-7` | Descriptor ownership and generated docs | Hand-maintained or contradictory command guidance | One generated decision table covers six controls, nine families, directions, strengths, contrasts, costs, and ceilings |
| 5. Normalize human readouts | Evidence sections/renderers in `navigation.ts:945-1113`; hidden blind-spot counts observed in graph output | Exact rows, folds, source identities, stable recovery | Hidden JSON-only limitations, unexplained strength labels, recommendation wording | Golden human-output tests enforce REQUEST → FACTS → STRENGTH/CALIBRATION → COVERAGE → RECOVERY |
| 6. Separate operational and exploration panels | `status --capabilities` combines operational telemetry and relationship support; default help exposes 99 commands | Full command availability and stable JSON | Flat default agent palette and duplicated status/capability output | Default help groups exploration, analysis, quality, maintenance, and compatibility; capabilities default is concise and `--matrix` is exhaustive |
| 7. Revalidate provider ceilings and behavior compression | Provider registry and command reference declare current ceilings; `inspect --view behavior` sometimes emits the selected root verbatim | Source-complete behavior, exact qualifiers, registered provider contracts | Claims stronger than provider evidence and misleading `behavior` naming | Cross-provider corpus plus behavior/source output-contract tests for TypeScript and Rust |
| 8. Run accuracy-first held evaluation | Canonical artifacts and acceptance rule are recorded in `2026-08-08-navigation-inference-retirement.md` | Detached sandboxes, fixed commits, zero native reads, manual compound-fact audit | Agent-visible query budgets and literal matcher as sole authority | Repeat TSLint, meta-harness, and OpenCode; add collision task and one additional language/task shape |

Each slice must leave the repository type-correct, testable, and compatible before the next begins.

## Phase details

### Phase 1 — sensor correctness

- Make an exact tracked-text file selector authoritative even when the file has no compiler document. `outline` should return no compiler constructs plus honest unavailable coverage, not search symbol text elsewhere.
- Remove repository-wide leaf-name candidates from inspect's executable causal frontier. Preserve exact SCIP callsites and source-grounded imported/member targets. Count unresolved callsites and, if useful, display their exact source locations without inventing a target.
- Add adversarial same-leaf, built-in-member, unindexed-text-file, basename, and path/symbol collision tests.

### Phase 2 — non-oracle instruction contract

- Remove the semantic-query target from the model-visible benchmark prompt; continue recording query count externally.
- Remove anchor fallback from benchmark and capability guidance. Keep `anchors` callable only as deprecated compatibility.
- Rename `context` sections to neutral observations such as `RELATED SOURCE IDENTITIES` and `REUSE CANDIDATES`, and remove `context` from the canonical exploration shortlist. Keep it available for explicit change-planning tasks.
- Regenerate skills, command reference, agent catalogue, and repository guidance from the same descriptors.

### Phase 3 — canonical command semantics

- Make explicit graph projection the only documented and skill-taught meaning of `evidence`.
- Move legacy positional source evidence behind a deprecated compatibility command or internal compatibility branch that is hidden from ordinary help and generated examples.
- Hide `anchors`, `system-map`, `dataflow`, `slice`, `deep-chains`, and `convergence` from default help while preserving invocation and public data contracts through the declared deprecation window.
- Add `contrasts` for every canonical/specialized overlap that an agent could reasonably confuse.

### Phase 4 — generated cockpit manual

- Generate a concise capabilities panel from command descriptors and graph-relation provider contracts.
- Include: control, question answered, required input, returned fact, direction, evidence ceiling, non-claim, approximate cost, contrasting command, and gap-closing command.
- Teach the material-question-to-family/direction table from the audit. Do not accept English task intent as CLI input.
- Make `capabilities` the semantic manual. Keep `status` operational.

### Phase 5 — readout contract

- Normalize canonical human commands to render request, observed facts, evidence calibration, coverage, and exact recovery in that order.
- Define `exact`, `mixed`, `derived`, `candidate`, and `unknown` in human output and skills. A mixed edge must disclose which constituent evidence is exact and derived when that distinction changes the claim.
- Render every material blind spot in human output. Compact repeated limitations structurally; never hide them only in JSON.
- Explain inventory cardinality bases and fold recovery without requiring the agent to infer why counts differ.
- Ensure `behavior` either produces a statement-complete compressed representation or clearly labels a verbatim source unit.

### Phase 6 — surface separation

- Group default help into primary exploration, specialized analysis, quality/cleanup, maintenance, and formal modeling. Put compatibility commands behind an explicit compatibility/all view.
- Keep the installed skill short: six exploration controls plus task-triggered links to change, architecture, and health analyzers.
- Remove duplicated workflow prose from benchmark prompts once the installed skill is proven available in the sandbox.

### Phase 7 — provider calibration

- Audit every registered relation subtype against its fixtures and declared support ceiling.
- Add cross-language fixtures for exact identity/ownership/contract relations and partial execution/data/state/temporal relations.
- Treat general interprocedural value flow, heap aliasing, exceptional flow, reflection, generated dispatch, and unsupported framework adapters as explicit unavailable frontiers until a provider exists. Do not approximate them through lexical similarity.

### Phase 8 — evaluation and release gate

- Run focused tests after each slice, then formatting, typecheck, lint, API compatibility, architecture, full tests, and packaged CLI smoke tests.
- Repeat each held treatment/control enough to expose variance. Publish manual strict fact recovery, automatic matcher score, model tokens, rendered characters, semantic queries, continuations, native reads, model, prompt, checkout, index generation, and cleanup result.
- Reject any false exact identity or executable edge regardless of token savings. Reject cheaper treatment that loses material facts. Accept modest token overhead only for a material repeatable accuracy gain.
- Do not merge or publish until the sensor-collision corpus passes, canonical human limitations are complete, and held accuracy is non-inferior.

## Open uncertainty

The public compatibility boundary for a new hidden legacy source-evidence command must be checked against the generated API manifest before implementation. Resolve it with `npm run api:check` and the descriptor/public-consumer tests; preserve the current positional invocation if external consumers would otherwise break, but remove it from all canonical documentation and skills.
