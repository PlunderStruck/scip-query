# Vega_2.0 TLA+ Model Audit — 2026-07-01

Ran `tla verify` (post P0/P1/P2 + SANY three-way conformance) against all nine
TLA+ models in Vega_2.0's `docs/formal/`, in a read-only clone, cached
tla2tools v1.8.0. Every mapping predates the strict verifier (legacy
`allowUnknown` era; 8 of 9 waive 100% of their actions).

## Per-model status

| Model | TLC | SANY | Referents | Semantic conformance errors | Verdict |
|---|---|---|---|---|---|
| SubscriptionLifecycle (Hardened cfg) | PASS (58s) | ok | all resolve | **4** | **Nearly current** — an hour to green |
| StripeWebhookLedger | PASS | ok | all resolve | **8** | **Nearly current** |
| BillingAccessLifecycle | PASS | ok | all resolve | 28 | Mapping stale, model plausible |
| CheckoutActivationLifecycle | PASS | ok | all resolve | 58 | Mapping stale |
| SeatChangeLifecycle | PASS | ok | all resolve | 79 | Mapping stale |
| WorkSessionLifecycle (Hardened) | PASS (28s) | ok | all resolve | 210 | Mapping rough; big service files saturate alias matching |
| ProposalsAgentPipeline (Hardened) | PASS | ok | all resolve | 227 | Same |
| GitHubWebhookIndexingPipeline | **KILLED at 120s cap** (27 vars — state-space explosion, not a counterexample) | ok | all resolve | 220 | Model too concrete to check under default budget |
| AuthRefreshCompanionAuthorization (Hardened) | PASS (77s) | ok | all resolve | 2,394 | Scope/alias saturation avalanche — mapping needs rebuild |

## What this means

- **The models are internally sound**: 8/9 still TLC-prove their invariants, and
  these are real production models (SubscriptionLifecycle encodes a
  vulnerable-vs-hardened Stripe webhook policy pair with `HistoricalBug`
  regression configs — the exact discipline the tla-model-system skill teaches).
- **No hard drift**: zero `missing-referent` and zero `model-text` errors
  anywhere — every mapped symbol survived months of refactoring, every mapped
  name still exists in its module. The bindings are alive.
- **The semantic layer was never proven and now shows it**: all errors are
  three-way write/read divergences (`model-code-write`, `undeclared-write`,
  `model-mapping-write`) — the legacy mappings' hand-asserted read/write sets
  are too coarse for the SANY+AST verifier, amplified in large service files
  where generic variable names (status, session) saturate alias matching.
  Real divergences may be buried inside; triage the two nearly-current models
  first, where the error count is small enough to read.

## Tool bugs this audit exposed (added to followups)

1. `tool-runner` classifies a SIGTERM-at-timeout TLC run (exit 143,
   `timedOut: false`) as `failed` rather than `timed-out` — misleading for
   state-space explosions.
2. `TlaToolRunOptions.timeoutMs` exists but `tla verify` exposes no
   `--timeout-ms` flag, so big models cannot opt into longer TLC budgets.
3. At avalanche scale (10,724 findings on one model) output needs a
   root-cause-group cap with disclosure, like diff-gate has.

## Per-repo tuning to make the TLA tooling maximally useful on Vega

1. **Migrate mappings off `allowUnknown`** to per-fact waivers with reasons,
   starting with SubscriptionLifecycle + StripeWebhookLedger (4 and 8 errors —
   afternoon-sized). Use the verifier's derived write sets as the source.
2. **Narrow `scope`** per mapping to the specific files owning the modeled
   state (current scopes cover whole services → unmapped-write avalanches),
   and add discriminating `aliases` (e.g. `subscriptionRow.status`, not
   `status`).
3. **Wire trace recording**: `tla instrument` + run the existing service tests
   with `SCIP_TLA_TRACE` to get real traces, then `tla trace-check` — semantic
   acceptance instead of key-diffs. The billing/webhook models are ideal: their
   tests exercise exactly the modeled transitions.
4. **Bound GitHubWebhookIndexingPipeline**: 27 variables is too concrete —
   split the model or shrink constants per the skill's state-space rules; raise
   the TLC budget once the `--timeout-ms` flag exists.
5. **Gate it**: once green, add `tla verify` for the two flagship models to the
   repo's pre-commit ritual so mapping drift fails the same day it happens —
   the same day-zero property coverage contracts give enumerations.
