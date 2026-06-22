# Passthrough Boundary Evidence Result

Date: 2026-06-22

## Verdict

The passthrough analyzer now distinguishes direct forwarding debt from boundary-shaped forwarding signals.

A passthrough candidate is a small production callable whose body literally passes its parameters to one callee. The direct-cleanup referents are forwarding functions that add no stable name, policy, API shape, provider boundary, lifecycle role, or public facade. The signal referents are equally literal forwarders, but their names, modules, callees, or suppression comments indicate that the forwarding function may preserve a boundary users or runtime code rely on.

## Implementation

- Added shared cleanup boundary evidence in `src/queries/cleanup/boundary-evidence.ts`.
- Kept wrapper boundary output on the shared helper without changing wrapper semantics.
- Added `actionTier`, `boundaryEvidence`, and `recommendation` to `passthrough-candidates`.
- Used shortened symbol names plus file basenames for passthrough evidence so module words such as `capabilities` are visible without reintroducing generic `apps/api` path noise.
- Added capability, provider, transport, lifecycle, and access-policy vocabulary needed by reviewed rows.
- Printed passthrough tier, recommendation, and evidence in CLI text output.
- Discounted signal-tier passthrough rows in health scoring through `scoreCount`.
- Added fixture coverage for one boundary passthrough, one direct passthrough, and health score weighting.

## Validation Samples

Focused regression:

- `npx vitest run tests/queries/cleanup/passthrough-candidates-output.test.ts` passed.
- The fixture reports `storageAdapterDelete -> providerDelete` as `signal` with adapter/provider boundary evidence.
- The fixture reports `forwardValue -> innerValue` as `direct` with no boundary evidence.
- Health detail reports `2 passthrough candidate(s) (1.25 score-weighted)`.

Corpus sample:

| Corpus               | Command output                                                                                                   | Judgment                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `scip-query`         | 0 passthrough rows.                                                                                              | No local passthrough pressure after current filters.                                                                                |
| `Vega_2.0`           | Top 20 split into 14 `signal` and 6 `direct`.                                                                    | Good split. Signal rows cite provider, adapter, public, websocket, and capability evidence; direct rows are ordinary service calls. |
| `Vega_2.0`, limit 50 | `getSavedReport() -> getAccessibleSavedReport()` is `signal` with `accessible` access-policy evidence.           | Access-policy forwarding is no longer misread as direct cleanup.                                                                    |
| `SynthRunnerRust`    | 2 rows, both `signal`: `app:run()` lifecycle forwarding and `BubbleTrail.render_particles()` effects forwarding. | Rust names are classified through the same boundary vocabulary without language-specific assumptions.                               |
| `Stable_Management`  | 0 passthrough rows.                                                                                              | No evidence from this corpus.                                                                                                       |

## Judgment

This slice closes the passthrough output/schema blocker. Passthrough findings can now remain in hygiene output without pretending every literal forwarder is an inline/delete instruction.

Direct passthrough rows should count as local cleanup pressure. Signal passthrough rows should remain visible, but the recommendation asks the maintainer to review the boundary before inlining. Health scoring now reflects that by counting signal rows fractionally.

Remaining precision work is narrower: improve external package/export and framework entrypoint caveats, and consider richer public-facade evidence when package metadata is available. Those are follow-up precision improvements, not blockers for the current validation ledger.

## Verification

Completed during implementation:

- `npx vitest run tests/queries/cleanup/passthrough-candidates-output.test.ts`
- `npm run typecheck`
- `npm run build`
- Field corpus runs recorded under `/tmp/scip-query-validation/2026-06-22-passthrough-boundary/`

Full verification gate is recorded with the final work session output.
