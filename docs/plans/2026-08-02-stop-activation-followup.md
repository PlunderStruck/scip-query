# Stop activation and planning follow-up

## Goal

Keep a change agent on the shortest evidence path from current behavior to a
complete edit. The agent should load one phase owner, treat source already
shown by `plan-context` as read, wait for the anchor before choosing follow-up
queries, and activate a protected Stop hook by finishing its response.

## Changes

- Make `scip-audit` unambiguously read-only and keep it out of edit requests.
- Make `scip-plan` the single pre-edit owner for a planned source change.
- For migrations, anchor the current owner being retired so one packet can
  expose its consumers, forwarding surfaces, and reuse candidates.
- Do not reread source slices already present in the packet. Do not launch
  follow-up SCIP commands until the packet names a material gap.
- Explain that finishing the response activates Stop. Do not search for a Stop
  tool or inspect general CLI and controller help.

## Checks

- Skill routing and generated setup tests cover the new rules.
- Skill links, lint, build, API checks, and the full test suite remain clean.
- The final diff gate owns detector checks once.
