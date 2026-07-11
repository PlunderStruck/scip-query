# TypeScript Recent-Duplicates Expansion

Date: 2026-07-11

Verdict: **insufficient population evidence; supported relationship signal**.

## Claim under review

A recent duplicate is a similarity relationship whose Git addition history
places at least one endpoint inside the declared 100-commit window. An `echo`
joins a recent file to an older file; a `twin` joins two files introduced in
the same recent period. The reported domain-specific shared evidence must
exist in both source endpoints. Whether the pair should be consolidated is a
separate recommendation.

## Expanded pinned corpus

The deterministic seed `typescript-recent-duplicates-expansion-v1` ran the
full-history detector without a result limit against:

| Repository | Commit | Candidate frame | Outcome |
| --- | --- | ---: | --- |
| Vega_2.0 | `27757abf8fa1bd0bebd1d2cc173e55b301030522` | 3 | reviewed |
| openwork | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` | 3 | reviewed |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` | 1 | reviewed |
| traceroot | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` | 0 | supported zero |
| Neon_3D | `015b22c5e27580109d23a33fbcf4730e7007230f` | 0 | supported zero |
| on_main_mvp | `5faef0ffd5d17f9dc8058622a3f70005fd3232a6` | 1 | reviewed |
| agent_chat | `a86e71fc083a8e6b505186283fb8dc9fb83e708d` | unknown | indexing failed |

The `agent_chat` failure is recorded as an analysis failure, not converted to
a clean result or included in the precision denominator. Its inferred
TypeScript project could not be indexed by `scip-typescript` at the pinned
commit. The other six repositories completed with their advertised indexing,
source, semantic, and Git-history capabilities.

The ignored reproducible packet is
`reports/accuracy/2026-07-11T16-51-17-696Z-typescript-similarity-calibration.json`.
The committed machine-readable review input is
[`2026-07-11-typescript-recent-duplicates-expansion-verdicts.json`](./2026-07-11-typescript-recent-duplicates-expansion-verdicts.json).

## Review and replay

All eight emitted relationships were reviewed:

- all 16 endpoint files existed at their pinned commits;
- all 179 disclosed shared-evidence tokens occurred in both endpoints after
  translating the detector's React event label to JSX spelling and retaining
  Vue event spelling;
- all eight independent file-addition checks agreed with the reported kind:
  echo endpoints had distinct addition commits and twin endpoints shared an
  addition commit; and
- the corpus included callable, React component, React behavior, and Vue
  template relationships.

Observed factual precision is 8/8 across four repositories with findings. The
two-sided 95% Wilson lower bound is only 67.6%, far below the 90% certification
floor. A known-positive frontend fixture still recalls an intentionally newer
duplicate. No false factual relationship appeared in this replay.

The expansion therefore confirms the detector's narrow fact but does not
manufacture confidence from supported zeros or a failed repository. Its state
remains insufficient until a named future corpus or historical snapshot adds
substantially more natural findings. Recommendation utility remains uncertain:
shared structure and recency do not prove that specialization or separate
ownership is accidental.
