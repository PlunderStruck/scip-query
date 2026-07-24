# Architecture Coherence Vision

## Purpose

scip-query should help a maintainer answer two different questions:

1. What architecture does this codebase actually have?
2. Where does the implementation contradict the architecture the project intends to preserve?

The dependency graph can answer neither question alone. It records which files rely on which other files. Architectural judgment connects those facts to the real responsibilities, public contracts, runtime boundaries, and maintenance work that gave the code its structure.

The product vision is therefore a combination of:

- an `architecture` query that measures declared boundaries and dependency rules;
- a directory-architecture skill that helps an agent discover, name, test, and gradually enforce those rules;
- drift and health integrations that expose architectural changes without pretending every unusual import is a defect.

## Vocabulary

An architectural boundary is a named group of code with one stable reason to change, such as a domain model, rendering subsystem, persistence adapter, compiler frontend, or deployable service. A folder often represents a boundary, but a folder is only evidence of one: the decisive fact is the responsibility its files jointly serve.

A dependency edge is a directed relationship from code that relies on something to the code it relies on. For an import, `A -> B` means file A imports file B. The direction matters because changes to B can force changes in A.

A boundary edge is the same relationship after file edges are grouped by their architectural boundaries. Ten imports from UI files into domain files form one `ui -> domain` boundary edge with ten pieces of file-level evidence.

An allowed edge is a boundary dependency that agrees with a declared rule. A forbidden edge is an actual dependency that contradicts a declared rule about which responsibilities may rely on which others. Files being far apart or living under different directories does not by itself make the edge forbidden.

A reciprocal dependency is a pair of boundary edges in both directions, such as `source -> parser` and `parser -> source`. It is a review signal because neither boundary can change independently, but it can be intentional when the named boundaries are really one subsystem or meet through a deliberately shared contract.

A strongly connected component is a group of boundaries where every member can reach every other member through dependency edges. Its essential consequence is mutual change pressure: no member is directionally independent of the group. A component with many boundaries is evidence that the current names may not describe real separation.

A cycle-break candidate is a boundary edge inside a dependency cycle whose small amount of file-level evidence makes it a plausible place to inspect first. It is not automatically the correct edge to remove; a single import can expose either an accidental shortcut or a legitimate contract that the boundary model failed to name.

An architecture policy is the project-owned configuration that names boundaries and records dependency directions the maintainers are prepared to defend. Its rules are stronger than inferred folder conventions because the project explicitly chose them.

An architecture ratchet is an enforcement rule that permits recorded existing debt while preventing new violations. It lets a large codebase improve incrementally without requiring a speculative rewrite before the policy becomes useful.

Architectural coherence is the degree to which actual dependencies, named responsibilities, and declared dependency rules describe the same system. The tool should report the evidence needed to improve that alignment, not reduce coherence to a single score.

## Why `drift` Is Not Enough

Drift is movement away from a reference state or established pattern. A system can be statically incoherent without having changed recently, and it can change while remaining coherent. Therefore architecture needs a first-class report rather than being hidden inside `drift`.

`scip-query architecture` owns the complete boundary graph and policy
evaluation. `scip-query drift --architecture` reuses that report to show
direct declared violations together with mapping coverage and report-only
signals; it does not maintain a second policy engine.

Before this work, the source-layer table in
`src/queries/cleanup/drift-policy.ts` embedded repository-specific knowledge in
a general-purpose command. An unrelated repository using folders such as
`src/core` and `src/runtime` could therefore inherit scip-query's rules. That
table has now been removed: drift consumes only explicit project
configuration, and an unconfigured repository receives no architecture
violations.

## Configuration Model

The first configuration shape should be small enough to understand without learning a policy language:

```json
{
  "architecture": {
    "boundaries": [
      { "name": "domain", "paths": ["src/domain/**"] },
      { "name": "source", "paths": ["src/source/**"] },
      { "name": "runtime", "paths": ["src/runtime/**"] }
    ],
    "allowedDependencies": {
      "domain": [],
      "source": ["domain"],
      "runtime": ["domain", "source"]
    },
    "requireCompletePolicy": true,
    "requireAcyclic": true
  }
}
```

A boundary row names code; it does not yet prohibit anything. An `allowedDependencies` row is closed: when a row exists for `source`, every cross-boundary dependency not listed in that row is forbidden. A missing row means the project has not made a rule for that boundary yet. Same-boundary dependencies remain allowed.

This distinction lets a large repository describe mature boundaries first while leaving emerging or disputed areas in discovery mode.

`requireCompletePolicy` turns that gradual-discovery model into a finished
contract: every configured boundary must have a closed row, including an empty
row for a boundary that may depend on nothing. `requireAcyclic` independently
forbids multi-boundary strongly connected components. A project should enable
both only after the observed graph has been classified and repaired.

`requireResolvedBoundaries` closes the gap those two leave open. Same-boundary
dependencies are always allowed, so every edge inside a boundary is discarded
before `requireAcyclic` runs — which means a boundary coarse enough to contain
both sides of a cycle passes the check while saying nothing about the code
inside it. The rule quotients each boundary by its sub-directories and requires
that quotient to be acyclic too, so "no cycles" keeps its meaning as boundaries
grow. It reports the narrowest internal edge as the inspection point, because a
hidden cycle is usually one import against a dominant direction rather than a
tangle.

Four narrower rules close the remaining holes. `requireMinimalPolicy` rejects a
declared allowance no edge uses, because `requireCompletePolicy` checks only
that a row exists and a stale row widens the policy silently.
`maxBoundaryFanOut` and `maxBoundaryFiles` bound growth, since coarseness was
otherwise caught only when it hid a cycle. `testPaths` brings test files back
under enforcement — they are excluded from the compiler project and so from the
index, which put them outside every rule — judging each test against the
boundary of the code it covers, while still allowing it to reach anything that
subject transitively reaches or that reaches the subject. And a boundary may set
`subUnits: "file"` when its members form layers inside one directory.

The failure it prevents is specific: this repository's own configuration
declared 14 boundaries with `requireAcyclic: true` and reported zero cycles,
while six of those boundaries — holding 85% of all files — each contained an
internal cycle. The clean result was an artifact of granularity, not a property
of the code.

## What the Analyzer Should Report

The report should preserve both policy truth and graph evidence:

- mapped, unmapped, and ambiguously mapped files;
- boundary edges with importer count, imported-file count, total file-edge count, and representative file edges;
- forbidden edges, grouped by boundary pair rather than emitted as a flood of individual imports;
- reciprocal boundary pairs;
- strongly connected boundary components;
- the narrowest internal edges to inspect first for each component;
- policy coverage: which boundaries have closed dependency rows and which remain descriptive only.
- resolved `export ... from` dependencies as well as ordinary imports, so
  published barrel and package surfaces are governed;

The output tiers should remain explicit:

- **Direct finding:** an actual edge contradicts a declared rule, or a declared acyclicity rule is violated.
- **Signal:** reciprocity, a large connected component, low policy coverage, an unmapped file, or a narrow cycle-break candidate.

Inferred signals should not reduce health scores or block diffs until external calibration shows that acting on them reliably improves real codebases.

## Applying This to an Existing Large Codebase

The tool cannot discover the “best architecture” by optimizing graph shape. The best available architecture is the clearest model that preserves the system's real responsibilities and necessary behavior while reducing accidental change pressure. Finding it requires a staged investigation.

### 1. Inventory the system's referents

Read the repository guidance, package manifests, deployable entry points, routes, public exports, databases, message boundaries, tests, and build graph. Use scip-query to map consumers, dependencies, change surfaces, cycles, locality candidates, and historical co-change.

This identifies what the code actually does and which units already behave as maintenance units.

### 2. Name candidate boundaries

Do not assume every top-level directory is a layer. A layer is a responsibility ordered by dependency direction, such as presentation over application over domain. A subsystem is a responsibility that owns an end-to-end capability, such as authentication or a compiler. A package is a publication or build unit. A service is an independently running unit.

The architecture model may contain all four. The useful name is the one that predicts why its code changes and what it may depend on.

### 3. Classify boundary maturity

- A mature boundary is repeatedly expressed by code, documentation, tests, entry points, ownership, or history.
- An emerging boundary has a coherent responsibility but inconsistent placement or dependencies.
- An accidental boundary is mainly a convenience bucket, legacy pile, generated directory, or recent edit cluster.

Only mature boundaries should receive closed dependency rules initially.

### 4. Build a descriptive model first

Add boundary path patterns without `allowedDependencies` rows. Run `scip-query architecture --json` to inspect mapping coverage, actual boundary edges, reciprocal pairs, and connected components.

Revise names and path membership when the graph reveals that a supposed boundary has no independent responsibility or that one responsibility is split across several folders.

### 5. Declare the rules supported by evidence

For each mature boundary, state which other boundaries it is allowed to depend on and why. Record uncertain edges as unresolved decisions instead of silently allowing the entire current graph.

Run the report again. A forbidden edge is now a testable disagreement between implementation and policy, not the tool's opinion about directory distance.

### 6. Baseline and ratchet

Record reviewed existing violations with `scip-query health
--write-baseline`. Architecture identities name a forbidden boundary pair or
an explicitly forbidden boundary cycle, so moving a representative file does
not churn the ratchet. The default `scip-query diff-gate` architecture check
then rejects new identities while preserving visibility into recorded debt.
This turns architecture from a one-time diagram into a maintained contract.

### 7. Migrate narrow seams

Start with a narrow edge whose few file dependencies cross a mature rule. Determine whether the right repair is to move code, invert a dependency, extract a genuinely shared contract, combine falsely separated boundaries, or revise the policy.

Verify each slice with tests, typechecking, incomplete-migration checks, architecture analysis, and diff-gate before taking the next one.

## Example: Vega 2.0

For a codebase the size of Vega 2.0, the first pass should not invent a universal stack of layers. It should:

1. identify workspace packages, applications, servers, public entry points, data stores, and major feature or compiler/rendering subsystems;
2. map actual dependency traffic between those units;
3. read the architecture and ownership claims already present in docs and package surfaces;
4. classify candidate boundaries as mature, emerging, or accidental;
5. configure the mature boundaries descriptively;
6. inspect reciprocal pairs and large connected components with their file-edge breadth;
7. close dependency rows only where the intended direction is supported;
8. baseline existing violations and prevent new ones;
9. migrate one narrow, high-confidence seam at a time.

The initial result may be a mixture of layers and subsystems. That is preferable to forcing a neat diagram that contradicts the software. The model becomes stronger as verified migrations and maintenance history provide new facts.

## Delivery Sequence

### Slice 1: explicit measurement — implemented

- Add architecture configuration types and validation.
- Extract the reusable strongly-connected-component algorithm already embedded in `deep-chains`.
- Add a pure architecture graph analyzer and `scip-query architecture`.
- Extend the directory-architecture skill with the discover, declare, measure, and ratchet workflow.
- Keep architecture outside health scoring and diff-gate blocking.

### Slice 2: replace implicit drift policy — implemented

- Move scip-query's source-boundary rules into its `.scipquery.json`.
- Make drift consume architecture findings instead of repository-specific hardcoded folder rules.
- Add `drift --architecture` as a summary view.
- Preserve unused-import drift and keep sibling-pattern deviation opt-in.

### Slice 3: baselines and enforcement — implemented locally; external calibration remains

- Give architecture findings stable identities.
- Add report-only health visibility.
- Add a narrow default diff-gate ratchet for newly introduced declared violations, backed by the shared health baseline.
- Calibrate on scip-query, Vega 2.0, Stable Management, and structurally different external repositories before any score deduction.

### Slice 4: discovery assistance

- Add candidate-boundary evidence that combines paths, entry points, public surfaces, dependency neighborhoods, and co-change history.
- Have the skill produce a reviewable architecture draft, never silently write closed rules.
- Measure whether suggested boundaries and repairs survive maintainer review and reduce future cross-boundary churn.

## Success Criteria

The architecture feature is effective when:

- an unconfigured repository never inherits scip-query-specific rules;
- a configured forbidden edge is reported with concrete import evidence;
- broad and narrow boundary edges are distinguishable;
- large cycles are summarized without flooding the user;
- the agent can explain why each proposed boundary exists in the running system;
- existing debt can be ratcheted without a rewrite;
- acting on a recommendation improves ownership or dependency direction in externally reviewed codebases;
- the tool is willing to say “the policy is incomplete” instead of manufacturing certainty.
