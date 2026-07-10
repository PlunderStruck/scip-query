# Profile Identity Coverage Baseline

Date: 2026-07-10
Commit: `fe0a6d78bf676a2f1d05b05c8296ef98203e6823`

## Contract

The data-collection phase succeeds when every timed span can be attributed to a
stable command/project workload, exact local identities remain distinguishable,
indexing gains internal phase visibility, and command outputs remain unchanged.
Aggregate subsystem observations must never be presented as proven avoidable
time.

## Baseline Matrix

The repeated command matrix covered full health, dead, similar, wrapper,
complexity, doc-drift, and diff-gate paths. It produced 24,370 profile events,
including 24,342 spans and 79 distinct span names from 13 observed subsystem
prefixes.

| Coverage | Baseline |
|---|---:|
| Source `profileSpan` calls | 82 |
| Files containing spans | 22 |
| Span events observed | 24,342 |
| Distinct span names observed | 79 |
| Exact-identified events | 36 |
| Exact-identified span names | 3 |
| Workload-identified span names | 0 |
| Internally profiled indexing phases | 0 |

The largest unclassified cumulative span totals were Rust (13,412ms), dead
(11,804ms), semantic (9,358ms), candidate pipelines (9,269ms), health
(8,657ms), TypeScript (6,421ms), similarity (4,868ms), and consumer evidence
(4,927ms). These totals include nested work and are coverage evidence, not wall
clock or optimization claims.

The command pairs were output-size stable. Notable timings were health
6,559ms then 163ms due to the health report cache, dead 3,378/3,301ms,
complexity 1,648/1,596ms, wrapper 1,179/1,166ms, and similar 494/497ms.

## Decision

Proceed with identity coverage and more measurements. Do not choose an
optimization from this baseline because 76 of the 79 observed span names lack
an exact local identity and all 79 lack an aggregate workload identity.

## Post-Instrumentation Comparison

The completed measurement set contains 34,824 timed spans across 101 names.
Workload/subsystem identity coverage rose from 0/79 names to 101/101 observed
names. Exact coverage rose from 36 events across three names to 28,000 events
across five names, primarily because generic evidence-product reads now carry
their actual cache key.

This comparison does not mean 28,000 expensive duplicate computations were
found. Exact file reads account for 23,595 computations in the repeated broad
matrix, but all of those reads together measured 290ms. Consumer-evidence
product work remains the largest exact repeated computation at 1,215ms across
the complete matrix, with nested classify/provenance phases reported
separately.

The new aggregate lane exposed a much larger controlled observation outside
the exact-work lane: the persistent TypeScript service made 2,077 mailbox
requests during one `dead --full` run and took 25,765ms, while the direct
provider produced byte-identical output in 3,216ms. That fact is now measured;
optimization selection remains deferred.
