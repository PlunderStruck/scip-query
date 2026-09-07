# Complexity wave 3 — worker 1

Baseline: `6fa43612`. Exclusive ownership is the source/script files in `/tmp/complexity-wave3-worker-1-targets.json`; other workers edit separate files. No builds, reindexing, commits, or policy changes.

## Targets and plan

- system-map.ts: expandRuntimeBoundaryFrontier, systemMapTopologyRelationEndpoint, sourceBindingOwnerAtLine — separate runtime link eligibility/materialization, endpoint precedence tiers, and syntax binding classification.
- next-anchor-candidates.ts: compareNeutralNextAnchors — separate ordering dimensions while preserving short-circuit precedence.
- source-inspection.ts: buildInspection — separate search, location, and symbol evidence candidate assembly while preserving shared sequence and round-robin ordering.
- architecture.ts: detectCoarseBoundaries — separate subgraph construction and component findings.
- render-command-reference.ts: parseSkillCommands — separate frontmatter command section location and entry parsing.
- newly-unreferenced-residue.ts: newlyUnreferencedResidue, collectRemovedReferences — separate source facts collection, removed-reference accounting, and current-definition attribution.
- exploration-topology.ts: createExplorationTopology — separate ordered structural validation from coverage assembly.
- by-kind.ts: inferKindNumber — separate type signature and term-kind inference with original precedence.
- direct-navigation.ts: codeBatchText — separate per-entry rendering and literal/coverage sections.

Preserve validation/error order, runtime acceptance, bounds, defaults, output order, attribution/coverage accounting, and resource effects. Inspect complete targets and required types. Check all target/helper complexity against cyclomatic <=10 and cognitive <=15; run focused source tests, changed-file ESLint/Prettier, and review exact diffs before freezing. Root handles combined verification.

## Results

All twelve targets refactored across nine source/script files. Exact diffs reviewed locally and by root. No exported API, policy, threshold, suppression, build, index, or package change. No shared tests edited.

Runtime boundary eligibility remains candidate/floor/represented checks, then endpoint existence/scope and reached-depth checks; materialization retains from/to additions, source fallback, depth writes, relation write, represented-link marking in order. Topology endpoint tiers retain callable symbol, preferred participant, explicit source construct, participant, enclosing source construct, known module symbol, region. Binding syntax preserves identifier/property predicates and readable-unit fallback.

Inspection state is per invocation, preserves round-robin search assembly followed by locations then evidence, sequence increments and priorities, reference ownership fallbacks, and returned key order. Topology validation retains anchor/node/edge/path/frontier/route checks and errors in order. Reference-removal coverage, unique-definition attribution, base-path/import attribution, calls-before-identifiers preference, source absence, unavailable records, and final sort remain unchanged. For-of result aggregation avoids introducing a call-argument-size bound. Kind normalization reuses the existing type-signature precedence with Class fallback. Frontmatter retains top-level precedence, quoting, blank lines, section boundaries, entry mutation, and error messages. Code rendering retains source deduplication and ordered coverage/error sections.

### Verification

- 244 distinct tests across 10 existing files passed across initial focused run and affected-file rerun: system-map (63), source-evidence (35), exploration-topology (20), next-anchor-candidates (6), architecture (32), newly-unreferenced-residue (2), command-accuracy (23), source-emission-session (8), render-command-reference (12), cli-contract (43).
- Initial run exposed seven source-evidence failures from one missed `candidates` to `state.candidates` replacement; corrected, and all 35 source-evidence tests passed on rerun. Architecture and residue rerun after ordered aggregation correction.
- Changed-file ESLint passed. Prettier and whitespace verification performed before freeze.
- Current-source health/review exports: `/tmp/complexity-wave3-worker1-health-final.json`, `/tmp/complexity-wave3-worker1-review-final.json`, `/tmp/complexity-wave3-worker1-script-health.json`, `/tmp/complexity-wave3-worker1-script-review.json`; selected numeric records in `/tmp/complexity-wave3-worker1-metrics.json`. Scans cover current working-tree source with other lanes editing; no aggregate-completeness claim.
- Every measured target and added helper/callback is <=10 cyclomatic and <=15 cognitive. Target values below are cyclomatic/cognitive.

- detectCoarseBoundaries: 5/7
- expandRuntimeBoundaryFrontier: 4/3
- sourceBindingOwnerAtLine: 7/6
- systemMapTopologyRelationEndpoint: 9/8
- collectRemovedReferences: 4/3
- newlyUnreferencedResidue: 8/5
- createExplorationTopology: 9/4
- compareNeutralNextAnchors: 2/1
- inferKindNumber: 10/7
- buildInspection: 1/0
- codeBatchText: 1/0
- parseSkillCommands: 7/6

### Limits and handoff

No new regression test was needed: existing focused tests exercised the extraction failure and relevant contracts. Direct code renderer extraction is covered by exact diff review and CLI contracts; root owns final combined built CLI verification, type checking, full suite, API checks and diff impact. All worker-owned tests and scan processes have exited. Source and tests frozen; subsequent work is read-only cross-review.
