# passthrough-candidates --full Optimization Ledger

## Output Contract

- Target command: `scip-query passthrough-candidates --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: return the same JSON envelope shape and preserve the
  `PassthroughCandidate` contract: forwarding symbol, forwarded-to symbol,
  source location, action tier, boundary/public-facade evidence, and
  recommendation.

## Current Pipeline

- `passthroughCandidates()` creates a `ProjectIndex`, collects production
  callable definitions up to the LOC threshold, sorts small definitions first,
  builds a bulk callee map, then evaluates each candidate.
- `passthroughCandidateForSymbol()` keeps only symbols with one unique callee,
  checks the body shape with `isLiteralPassthrough()`, computes boundary and
  public-facade evidence, and builds the result.
- The current suspected bottleneck is the per-candidate literal body-shape
  check or per-result boundary/public evidence, because callee evidence is
  already prepared in bulk.

## Measurements

| Case | Before | After | Delta | Evidence |
| --- | ---: | ---: | ---: | --- |
| Vega_2.0 refreshed heavy matrix `passthrough-candidates --json --full` | 68.96s | pending | pending | `scip-query bench --json --include-heavy --timeout-ms 600000` |
| Vega_2.0 focused warm `passthrough-candidates --json --full` | 68.96s | 1.430s | -67.5s / 48x faster in warm evidence-cache state | `scip-query bench --json --command "passthrough-candidates --json --full" --timeout-ms 600000`; stdout 146,739 bytes |

## Decisions

- Accepted: the current bottleneck is primarily cold source-facts evidence
  construction rather than the steady-state passthrough candidate loop. A warm
  focused run returns the same output size in 1.430s, so the next optimization
  should target source-facts cold-build cost or benchmark reporting, not a blind
  rewrite of passthrough scoring.
- Rejected: none yet.
- Deferred: none yet.
