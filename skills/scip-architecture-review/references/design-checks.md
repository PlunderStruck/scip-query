# Design checks

Load for concerns sharing a design cause or changes crossing owners.

Look for one responsibility behind several mechanisms: repeated resource lifecycles, copied failure policy, separate registries/docs describing one command surface, or repeated eligibility calculations. Establish sameness from behavior, state, and consumers.

A consolidation should remove duplicated knowledge or prevent inconsistent decisions. A wrapper accepting many callbacks may move coordination without removing it. Preserve grammar, protocol, platform, and compatibility differences when they change the contract.

Consider removing a redundant layer, placing a repeated rule behind an existing owner, deriving repeated representations from an authoritative registry, or separating unrelated responsibilities. Choose a coherent mechanism preserving behavior; minimum file size and line count are not objectives.

Use realistic product changes to test the benefit: alter eligibility, replace a storage representation, add an operation, or change retry policy. Identify the old places an agent must discover/coordinate and the proposed places. Explain remaining necessary cross-module edits.

Read consumers capable of refuting the interface. Preserve incomplete consumer coverage; a simple caller does not prove every caller can use the same operation.

For multi-step work keep concerns, owners, consumers, dispositions, dependency order, and checks in one plan. Link symptoms to their shared cause. Name obsolete implementations, routes, registrations, fallbacks, artifacts, and docs to retire. Preserve resource identity, state transitions, and observable ordering. Adding a new implementation beside an old live one does not complete consolidation.

Evaluate the workflow using representative tasks with and without the tool/skill, the same model and constraints, and repeated trials where variability matters. Include coherent designs and intentional adapters alongside defects. Inspect actual patches and tests for missed consumers, duplicated rules, incorrect behavior, and unnecessary edits. Measure structural accuracy separately from design conclusions; fewer findings do not prove better agent-produced code.
