# Per-repo triage (once, after setup)

New repos surface standing findings that are intentional. Encode them once so
every later gate run is precise, instead of re-litigating the same findings
every time `diff-gate` runs.

1. Sweep initial findings with `health --json` and `diff-gate --json`. For
   each accepted finding, run `suppress <id> --reason <why>` — reasons are
   required and audited.
2. Declare files that legitimately change together in `.scipquery.json`
   `declaredCouplings`.
3. List dated snapshot docs (benchmarks, validation ledgers, historical
   plans/reviews) in `docs.snapshotPaths` so doc checks skip them with a
   labeled exclusion instead of recurring findings.
4. Seed `coverageContracts` for every hand-maintained enumeration (policy
   maps, capability tables, registry lists) so enumeration rot fails the gate
   the day it happens.
5. Set a hygiene cadence: run the twin-drift and claim scenarios in
   `scip-audit` after
   large refactor campaigns or quarterly. The gate only sees diffs; these
   lenses see accumulated state.

Complete only when a clean working tree produces a finding-free `diff-gate`
and every suppression carries a reason a reviewer would accept.
