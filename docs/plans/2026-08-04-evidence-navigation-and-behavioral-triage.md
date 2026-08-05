# Demand-Driven Source Evidence and Behavioral Triage

Date: 2026-08-04

Status: architecture revised after implementation evidence and three external reviews; replacement vertical slice in progress

## Decision history

The first version of this plan treated a compiler graph plus a precomputed runtime-boundary graph as the evidence foundation. That was reasonable before the first repository-scale implementation: the compiler graph could not cross HTTP, event, queue, registry, or persistence-mediated relationships, so adding source-grounded observations and explicit exact/candidate links was the smallest testable extension.

The Vega implementation and benchmark changed the classification. The prototype produced 1,985 observations, 2,041 links, 1,920 unresolved frontiers, and only 42 exact links. None of those exact links participated in the benchmark system map. Most candidate links were a pairwise persistence cross-product, wrapper propagation produced one observation in the whole repository, and relevant HTTP endpoints remained unresolved because their addresses flowed through imported constants, route mounts, and multi-hop wrappers.

Three subsequent reviews converged on the same correction: runtime protocols are rendered views over a more fundamental value, symbol, scope, and provenance model. This document therefore retains the original mission and user-facing zoom model but replaces the internal graph construction and narrows the next implementation to one falsifiable TypeScript HTTP-plus-registry slice.

## Mission

Across a preregistered distribution of repository-understanding tasks, scip-query must produce non-inferior factual completeness and false-claim rates with lower exploration cost than ordinary source exploration. When an abstraction cannot help, it must fall back to exact source with bounded overhead. Every reduction must disclose omissions relative to the declared query plan and supported analyses.

The target cannot honestly promise fewer tokens for every question in every repository. A one-function question may already have a minimal native answer, and reflection, deployment configuration, generated artifacts, runtime state, or external services may exceed static-source knowledge. The product claim is a distributional result with explicit scope, not a universal per-task guarantee.

The measured outcome is a joint result rather than whichever token metric is favorable after a run:

- factual completeness must be non-inferior;
- false material claims must not increase;
- provider-reported total, cached, uncached, output, and reasoning tokens remain separate;
- serialized tool-output tokens, unique source exposure, repeated source exposure, peak context, calls, failures, and elapsed time are recorded;
- provider-weighted cost may be reported using the price schedule active for the run, but it does not replace raw token accounting; and
- no efficiency improvement counts when it causes a material accuracy regression.

## Product definition

scip-query is a demand-driven source-evidence compiler: an indexed analysis system that transforms source-established facts into the smallest evidence packet selected by a declared investigation while preserving the derivation and exact source behind every conclusion.

A source fact is an identity, value, syntax relation, compiler relation, scope classification, or source span established directly by the indexed repository and its build context. Its distinguishing property is that replaying the same supported analysis over the same revision re-establishes it without semantic guessing.

A derivation is a deterministic rule application that produces one fact from other identified facts and retains the rule version, inputs, and source spans needed to replay the conclusion. A derived fact earns traversal rights from that replayability, not from a scalar feeling of confidence.

A query plan is a structured request containing anchors, relation families, direction, source scope, evidence floor, and an output budget. The agent translates the English task into this plan; scip-query performs evidence retrieval and structural reasoning without inferring the user's prose intent.

Query closure is the reported state in which every fact reachable under the declared relations, directions, evidence floor, source scopes, and analysis capabilities has been accounted for as emitted, withheld, ambiguous, external, or unresolved. It does not certify that an English answer is globally complete.

## Architecture

```text
repository source + build/index context
                    │
                    ▼
          immutable source-fact store
 symbols, calls, imports, AST/CFG, constants,
 declarations, registrations, spans, source scope
                    │
                    ▼
        mechanical derivation subsystem
 bounded value evaluator + function summaries +
 terminal adapters + proof DAG + contract relations
                    │
                    ▼
        typed relational evidence layer
 observations, channels, resource memberships,
 relation groups, carrier bindings, frontier buckets
                    │
                    ▼
          demand-driven query compiler
 anchors + relations + direction + scope + evidence floor
                    │
                    ▼
       system map → construct packet → exact source
                    │
                    ▼
      provenance + coverage + recovery at every view
```

The four internal responsibilities remain separate:

1. Evidence acquisition records what source, parser, compiler, or index directly established.
2. Mechanical derivation computes only conclusions supported by named replayable rules.
3. Query-relative selection chooses which proven evidence can change the current investigation.
4. Rendering chooses the cheapest faithful source resolution for that selected evidence.

The user-facing views are not the storage architecture. They are projections of one evidence model.

## Evidence model

One `exact | candidate` field conflates different questions. Evidence records must preserve independent properties:

| Property         | Values                                                         | Question                                              |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| Derivation       | direct, mechanically-derived, heuristic                        | How was the fact obtained?                            |
| Value precision  | literal, finite-set, constrained-pattern, symbolic, unknown    | How precisely is the value known?                     |
| Runtime modality | must, may, unknown                                             | Does source prove necessity, possibility, or neither? |
| Resolution       | locally-linked, external, unresolved, ambiguous                | Was a counterpart established?                        |
| Source scope     | production, test, fixture, example, generated, script, unknown | Which evidence surface contains it?                   |

Exact value identity does not imply that an operation executes on every runtime path. A direct call under a branch may be `literal` and `may`. Conversely, a mechanically derived value may safely drive traversal when every step is deterministic and replayable.

The conceptual model is:

```typescript
type Term =
  | { kind: 'literal'; value: string }
  | { kind: 'finite-set'; values: string[] }
  | { kind: 'parameter'; callable: string; position: number }
  | { kind: 'concat'; parts: Term[] }
  | { kind: 'property'; base: Term; key: string }
  | { kind: 'pattern'; language: string; value: string }
  | { kind: 'symbol'; symbol: string }
  | { kind: 'unknown'; reason: string };

interface Observation {
  id: string;
  owner: SourceIdentity;
  executionDomain: string | null;
  protocol: string;
  role: string;
  fields: Record<string, Term>;
  carrier: CarrierIdentity | null;
  source: SourceLocation;
  sourceScope: SourceScope;
  derivation: DerivationRef;
}

interface FunctionSummary {
  callable: SourceIdentity;
  observations: ObservationTemplate[];
  returns: Term[];
  effects: EffectTerm[];
  guards: SourceSpan[];
  derivation: DerivationRef;
}

interface RelationGroup {
  protocol: string;
  joinRule: string;
  constraints: Record<string, Term>;
  producerIds: ObservationId[];
  consumerIds: ObservationId[];
  modality: RuntimeModality;
  derivation: DerivationRef;
}

interface FrontierBucket {
  protocol: string;
  joinRule: string;
  knownConstraints: Record<string, Term>;
  missingFields: string[];
  reason: string;
  producerIds: ObservationId[];
  consumerIds: ObservationId[];
  representatives: SourceLocation[];
  expansionCommand: string;
}

interface Derivation {
  rule: string;
  ruleVersion: string;
  inputFactIds: string[];
  sourceSpans: SourceLocation[];
}
```

Production storage may use normalized rows, indexed sets, or bitmaps rather than these literal arrays. The invariant is factorization: shared information is stored once, and pairwise products are materialized only for a bounded query that actually needs individual pairs.

## Fundamental relation families

### Compiler relations

Definitions, references, calls, implementations, imports, exports, and re-exports retain compiler-established symbol identity and coverage.

### Contract-symbol relations

A contract symbol is an exported symbol referenced across independently compiled workspaces or packages. Its defining property is that compiler identity, rather than a guessed runtime protocol, proves that several components share one declared route, schema, discriminator set, request shape, or response shape.

Contract-symbol relations are first-class system-map evidence. They can connect a web client through a shared contract package to an API handler with no protocol-specific inference. They do not replace runtime derivation where components deliberately duplicate a wire literal instead of sharing a symbol.

### Protocol channels and relation groups

A channel is a normalized runtime rendezvous address to which producer, consumer, and declaration observations attach. Examples include one HTTP method/path within one execution domain, one event channel on one proved bus instance, one queue identity, or one registry discriminator within one carrier.

Channels and relation groups replace pairwise candidate links. For `P` producers and `C` consumers, storage is proportional to `P + C`, not `P × C`. Individual endpoint pairs are a bounded query-time view.

Persistence is resource incidence, not a default causal execution edge. Reads and writes attach to a resource group so impact and data-lifecycle queries can find participants. A shared table does not prove that one selected write caused one selected read and therefore does not drive ordinary control-flow traversal.

### Carrier bindings and nested dispatch

Nested protocols remain separate relations:

```text
HTTP request
  → HTTP route channel
  → request carrier binding: client body.command ↔ server body.command
  → discriminator channel: work_session_stream_events
  → registered command handler
```

The HTTP endpoint and command discriminator are not flattened into one synthetic key. Each hop has its own proof and may resolve independently.

## Runtime derivation

### Terminal adapters

An adapter is versioned ecosystem knowledge that identifies a terminal library operation and declares the meaning of its receiver, arguments, return value, payload fields, and mount behavior. It fires only when import provenance, resolved receiver identity, constructor provenance, annotation identity, or another adapter ground condition is established.

Adapters are shipped per ecosystem, not configured per repository. Repository-specific adapters remain an optional escape hatch for proprietary protocols. Generic names such as `.on`, `.emit`, `.send`, `.publish`, `apiRequest`, or `httpRequest` establish no protocol meaning by themselves.

### Bounded value evaluation

One evaluator resolves terms used by every adapter and wrapper summary:

- literals and interpolation-free templates;
- templates and concatenations whose parts remain symbolic;
- local immutable bindings;
- object-property initializers when relevant mutation is ruled out;
- imported and re-exported constants through compiler identity;
- route parameters and wildcard patterns;
- route-prefix and mount composition; and
- finite sets such as command arrays, unions, and schema enumerations.

When mutation, aliasing, reflection, arbitrary computation, environment configuration, or unsupported syntax prevents proof, the term remains symbolic or unknown with a named reason. The evaluator does not guess.

### Interprocedural summaries

Boundary roles are derived backward from terminal operations. If a terminal request receives its path from parameter 2 of `apiRequest`, the summary records `path := parameter 2`; it never assumes argument zero from the function name.

At compiler-resolved callsites, actual argument terms substitute for formal parameters. Summaries propagate through a bounded fixed point with cycle detection and a retained proof chain. Partially unknown fields remain holes and do not invalidate independently known fields.

### Join order

Relations are attempted in decreasing determinism:

1. shared compiler symbol identity;
2. canonical term equality or proved route-pattern compatibility within one execution domain;
3. role-distinct discriminator equality tied through a mechanically established carrier;
4. explicitly labeled heuristic candidates available only by opt-in.

Only direct or mechanically derived relations drive default traversal. External endpoints terminate traversal. Ambiguous and unresolved observations become grouped frontiers. Heuristic candidates never silently widen the system map.

### Source scope

Test, fixture, example, script, generated, and production observations retain their scope. Production traversal excludes non-production endpoints by default. Tests remain separately useful as witnesses and may be requested explicitly.

## Query compilation and relevance

Anchors are necessary but do not completely specify an investigation. The command surface should expose a small structural algebra:

```text
seed(selectors)

expand(set, relations, direction, evidenceFloor, sourceScope, budget)

connect(anchorSets, relations, evidenceFloor, sourceScope)

slice(sources, sinks, relations, budget)

project(constructs, representation)
```

The agent supplies direction and relation policy as command parameters rather than asking scip-query to infer English intent. A deterministic anchor catalog supplies exported APIs, route registrations, event endpoints, persistence models, registries, package entry points, changed symbols, and associated tests when no obvious seed is known.

Ranking orders evidence within the declared query; it does not decide truth or erase existence. Useful signals include anchor rarity, derivation quality, weighted graph distance, participation in paths connecting independent anchors, multi-anchor convergence, bridge position, edge family, source scope, fan-out penalty, and evidence already observed. Personalized graph ranking may be tested as one implementation, not assumed as the architecture.

The tool never silently filters:

- explicit anchor matches;
- proved edges leaving the visited set;
- ambiguity sets on traversed relation groups;
- frontier buckets touching the visited set;
- source-scope exclusions; or
- unsupported requested relation families.

## User-facing evidence views

### System map

The map is a query result showing selected constructs, contract symbols, proved paths, runtime relation groups, why each unit was selected, unresolved frontiers, scope, and traversal coverage. It must be small relative to the source reads it prevents.

Repository-wide analyzer totals and query-relative totals are reported separately. The old output mixed 42 repository-wide exact links with zero map-relative traversals and made the counts appear directly comparable.

### Construct evidence packet

The middle view is a source-accounted packet rather than one universal behavioral format. Depending on the construct and question, it may select:

- declaration, signature, type, annotation, and public contract;
- control flow, guards, calls, effects, mutations, exits, and failures;
- route, schema, registry, resource, or configuration declarations;
- a normalized executable outline;
- a complete key list plus a representative repeated body; or
- raw source when compression is unsafe or uneconomical.

For executable projections, structure may be normalized but predicates, short-circuit operators, boundary-call arguments, mutation targets, regexes, important literals, and thrown or returned error values remain verbatim. Unsupported syntax is copied verbatim.

Statement accounting is necessary but does not prove semantic fidelity. Tests must separately establish evaluation order, guards, calls and argument positions, awaits, exceptions, mutation targets, switch fallthrough, concurrency, and source-span recovery.

The projection decision uses target-model token estimates when available, rendering and provenance overhead, syntax risk, and observed exact-source fallback rate. Small, semantically dense, or commonly re-opened constructs return raw source. A projection followed by an exact read is measured as a double-read loss.

### Exact source

Exact source remains authoritative and independently recoverable. It is never suppressed because an earlier map, declaration, preview, or construct packet included part of the same span.

## Coverage and stopping

Every response carries the smallest coverage manifest required to interpret it. A complete programmatic form contains:

- repository revision and freshness;
- indexer, compiler, adapter, and rule versions;
- resolved and unresolved seeds;
- requested relation families and directions;
- evidence floor and included source scopes;
- proven reachable units: total, emitted, and withheld;
- relation groups not expanded;
- frontier buckets by protocol and reason;
- unsupported syntax and analysis regions;
- dynamic, reflection, configuration, and external boundaries;
- construct source accounting;
- exact spans already observed; and
- recovery commands.

Human output condenses this without replacing it with a bare `safe to stop`. The stopping rule is: every material answer claim has source evidence, every supported neighbor under the query plan is accounted for, and every remaining frontier has been resolved, classified as external, or explicitly judged immaterial by the agent.

Closed-world claims are always qualified by their declared scope, such as “all seven compiler-indexed production callsites under this revision,” never phrased as universal runtime truth.

## Token causation

In a linear transcript, an output of size `s` introduced with `r` subsequent model turns may contribute approximately `s × (r + 1)` input tokens because the prefix remains in later requests. Provider caching changes cost and compute accounting but not the cumulative token count. This explains why large early batches can reduce uncached tokens and calls while increasing total input tokens.

The resulting rules are:

1. Selection precision has the greatest leverage because omitted irrelevant evidence is never repeated.
2. Early outputs contain topology, counts, and selection information rather than broad source bodies.
3. Batching combines independently necessary evidence; it is not a fixed request for twelve large units.
4. Deduplication prevents byte-identical evidence from being reintroduced.
5. Stopping support prevents defensive exploration after query closure.
6. Per-unit compression helps only after selection and must include verification fallbacks.
7. Transport pagination moves already-selected bytes and is never used as relevance selection.

Context-firewalled subagents may eventually keep raw exploration outside the main transcript. That architecture complements scip-query when subagents return citation-backed claims and proof references; it does not remove the need for source provenance and coverage.

## Benchmark evidence

The current protected Vega task asks for the end-to-end work-session stream-event path at a fixed source commit. Its 15 material facts cover companion input, HTTP dispatch, authorization, service policy, normalization, persistence, realtime publication, web refresh and recovery, retrieval, and rendering.

Latest valid control:

```text
manual factual score        15/15
elapsed                     881,600 ms
total model tokens          10,699,951
uncached model tokens          548,527
output tokens                   34,801
tool calls                          155
```

Pre-slice treatment baseline:

```text
manual factual score        approximately 14/15
elapsed                     884,657 ms
total model tokens          10,320,197   (-3.5% vs matched control)
uncached model tokens          346,949  (-36.8%)
output tokens                   29,937  (-14.0%)
tool calls                          109  (-29.7%)
scip-query commands                   90
```

Against a five-control median, the treatment used 26.7% fewer uncached tokens and 28.3% fewer calls but 29.6% more total tokens. It is an efficiency signal, not a general product claim.

The agent read exact source containing both omitted web predicates. The accuracy regression therefore cannot be attributed solely to behavioral predicate loss. It is evidence of attention density and final synthesis loss. Predicate-preserving construct packets may make those facts more salient, but that hypothesis requires an ablation.

The treatment used no relevant runtime-boundary traversal. Its gains came from compiler/literal navigation, map selection, batching, preview deduplication, and guidance. Runtime derivation must establish independent utility before expanding to more protocols.

### Implemented vertical-slice validation

The TypeScript HTTP/carrier slice, relation-policy system map, construct packets, selection accounting, and source-session ledger were implemented and validated together on 2026-08-04.

Mechanical and repository validation:

```text
Vitest                         271 files, 2,154 tests passed
TypeScript                     passed
format/lint/build/API contract passed
architecture policy           passed; zero forbidden edges
Vega indexed observations     1,334
Vega relation groups            612
Vega materialized links           27
Vega unresolved frontiers        621
```

From the exact `work_session_stream_events` discriminator, the Vega index derived the companion producer and API registry consumer through `POST /api/v1/agent-dispatch` and body field `command`. One system-map query produced 11 regions, traversed 10 query-relevant runtime links, and rendered 10,086 characters with explicit closure accounting. Narrowing a four-location behavior packet to the relevant registry member reduced its rendered size from 13,380 to 5,055 characters, a 62.2% reduction, while preserving every executable statement or a raw-source fallback.

Two post-slice Luna Max treatments used the same pinned Vega commit, prompt, and hidden facts. The source-session ledger was the only intended mechanism difference:

| Metric                         |    Control | Post-slice, ledger off | Post-slice, ledger on |
| ------------------------------ | ---------: | ---------------------: | --------------------: |
| Conservative factual score     |      15/15 |                  15/15 |                 12/15 |
| Elapsed milliseconds           |    881,600 |                942,697 |             1,034,292 |
| Total model tokens             | 10,699,951 |             10,464,931 |            10,791,144 |
| Uncached model tokens          |    548,527 |                343,459 |               379,880 |
| Output tokens                  |     34,801 |                 32,257 |                31,491 |
| Tool calls                     |        155 |                    104 |                   122 |
| scip-query commands            |          0 |                     86 |                   105 |
| Repeated-source citation stubs |          0 |                      0 |                    69 |
| Source-citation calls          |          0 |                      0 |                    22 |
| Re-emission calls              |          0 |                      0 |                     0 |

With the ledger off, the post-slice treatment used 2.2% fewer total tokens, 37.4% fewer uncached tokens, 7.3% fewer output tokens, and 32.9% fewer tool calls than the control while matching its 15/15 factual score. It took 6.9% longer. This is a successful result for the combined map, selection, construct-packet, runtime-relation, and guidance surface on this task, not a general product claim.

With the ledger on, repeated unchanged spans were mechanically replaced by 69 citation stubs without any re-emission. Nevertheless, the agent made 17.3% more calls and used 10.6% more uncached tokens than the ledger-off treatment. It also omitted three scored web/rendering details from its final synthesis. The ledger therefore proved byte deduplication but failed the tokens-to-correct-answer gate in this sample. It remains experimental and opt-in until it also suppresses repeated locating decisions or wins a repeated-run ablation.

The two treatments also followed different exploration trajectories, so their delta is not a causal estimate of the ledger alone. The defensible conclusions are narrower: the full ledger-enabled stack did not win this run; the ledger-off post-slice surface did; and repeated matched trials are still required.

## Revised implementation sequence

### Phase 0 — Freeze and instrument

- Preserve fixed repository commits, prompts, scoring facts, model settings, executable hashes, guidance hashes, and dirty-source identity.
- Record unique and repeated source tokens, construct-packet tokens, proof/coverage overhead, exact-source fallback, and per-output transcript lifetime.
- Retain current Vega analyzer counts and agent runs as the pre-replacement baseline.

### Phase 1 — Remove unsound noise

- Delete pairwise persistence candidate links; retain factorized resource membership.
- Disable generic protocol recognition without receiver/import proof.
- Delete function-name and presumed-argument-position wrapper rules.
- Classify test, fixture, example, script, generated, and production observations.
- Split repository-wide and query-relative boundary coverage.
- Redefine a frontier as a query-reachable production observation with an unresolved address or no counterpart role, not simply any observation lacking an exact pairwise edge.

Acceptance: candidate and frontier output collapses without losing any manually labeled proven relation; no test HTTP request becomes a production client.

### Phase 2 — Introduce the evidence core beside the prototype

- Add `Term`, independent evidence properties, `FunctionSummary`, `RelationGroup`, `FrontierBucket`, and shared derivation DAGs.
- Add indexed channel and source-scope access rather than one opaque project JSON value.
- Add contract-symbol relations to system-map.

Acceptance: every derived fact reconstructs its rule-and-source proof; a synthetic 1,000-by-1,000 partial join remains linear in stored participants.

### Phase 3 — Prove one TypeScript HTTP slice

- Implement cross-file constant and member-property resolution through compiler symbols.
- Implement route-pattern normalization and mount composition.
- Ground terminal client and server adapters in import or resolved receiver provenance.
- Derive parameter roles from terminal dataflow.
- Propagate summaries to a bounded fixed point through compiler-resolved calls.
- Preserve execution-domain and service identity.

Acceptance: arbitrary wrapper names and parameter positions resolve correctly through zero to three hops; mutation and ambiguous calls remain unresolved; no false mechanically derived links appear in a labeled fixture corpus.

### Phase 4 — Compose carrier and registry dispatch

- Bind client request fields to server request fields only through a proved transport carrier.
- Recognize registry declarations through `satisfies`, `as const`, annotations, and exported tables.
- Represent variable-key dispatch with a mechanically derived finite discriminator set where available.
- Join role-distinct exact discriminators inside the proved carrier.

Vega acceptance path:

```text
sessionStreamEvents
  → appendWorkSessionStreamEvents
  → dispatchAgentCommand
  → agentDispatchRequest
  → apiRequest
  → POST /api/v1/agent-dispatch
  → body.command = work_session_stream_events
  → dispatchWorkSessionCommandHandlers[work_session_stream_events]
```

The path must traverse from one suitable anchor with no repository configuration and print the proof for every derived hop.

### Phase 5 — Integrate selection and construct packets

- Compile system-map from a declared relation policy and evidence floor.
- Keep early topology payloads under an explicit token budget.
- Add declaration and route/schema/registry projections to construct packets.
- Preserve predicates and boundary arguments verbatim in behavioral projections.
- Report query closure instead of an unqualified stopping verdict.

Acceptance: ranked evidence recall per output token improves over simple structural ranking; construct packets reduce net tokens after exact-source fallbacks; no supported material fact is omitted in the fidelity corpus.

### Phase 6 — Validate and decide

- Run analyzer fixtures before agent benchmarks.
- Label HTTP and registry relations in Vega plus structurally unrelated repositories.
- Rerun the protected Luna task only after the vertical slice passes mechanical precision tests.
- Run guidance-only, compiler-navigation, map-only, construct-packet, runtime-relation, ledger, and full-treatment ablations.
- Use at least two models and held-out repositories before making a product-effectiveness claim.

Go: runtime relations measurably improve factual completeness or exploration cost at non-inferior accuracy, with near-perfect mechanically derived precision.

No-go: the vertical slice produces correct relations but does not change agent trajectories, its proof/coverage payload costs more than the reads it prevents, or its precision is not high enough to deserve traversal. In that case, retain exact contract-symbol navigation and concentrate on selection, evidence density, duplicate avoidance, and stopping.

Do not broaden to events, queues, persistence lineage, dependency injection, another language, or repository-specific adapters before this decision.

## Evaluation program

### Mechanical fixtures

Cover direct terminals, imported receivers, local/imported/re-exported constants, concatenated and mounted paths, wildcard patterns, wrapper chains, recursion, object mutation, duplicate paths in separate services, nested discriminators, variable-key registries, test scope, and external endpoints.

Measure exact-value precision and recall, derived-relation precision and recall, proof validity, frontier classification, group size, analysis time, and stored bytes. A false mechanically proven relation is a severe defect.

### Real-repository relation corpus

Use fixed commits from several languages and frameworks, with held-out repositories not used for adapter or ranking development. Report recall separately for direct literals, local constants, imported constants, one-hop wrappers, multi-hop wrappers, mounts, wildcards, nested dispatch, registry/DI indirection, and dynamic cases.

Measure frontier usefulness by the number of source units required to resolve one, gold-relation recall within the first few expansions, and whether exact search would have been cheaper.

### End-to-end agent tasks

Balance explanation, lifecycle, value transformation, impact, bug localization, invariant enumeration, ownership, planning, and external-boundary tasks. Pre-register atomic facts, forbidden false claims, materiality, commits, prompts, and scoring before holdout runs.

Use native exploration, compiler-navigation-only, and full-treatment conditions plus mechanism ablations. Run repeated paired trials, randomize condition order, distinguish cold and production cache behavior, score blind, and report uncertainty over tasks rather than treating repetitions of one task as independent repositories.

## Mechanisms retained, replaced, and deferred

| Mechanism                    | Decision                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| System map                   | Keep as a compact query result over typed evidence.                                                                                        |
| Contract-symbol relation     | Add as a compiler-exact first-class relation.                                                                                              |
| Behavioral outline           | Generalize into construct evidence packets and strengthen fidelity.                                                                        |
| Runtime-boundary prototype   | Replace its extraction and pairwise joining core.                                                                                          |
| Selector cardinality/ranking | Keep; ranking orders recoverable evidence.                                                                                                 |
| Complete identity manifest   | Keep and extend to relation/frontier groups.                                                                                               |
| Batched inspection           | Keep for independently necessary units, not fixed broad batches.                                                                           |
| Preview ledger               | Keep experimental and opt-in; exact byte deduplication worked, but the first post-slice ablation failed the tokens-to-correct-answer gate. |
| Short transport cursors      | Keep as transport hygiene only.                                                                                                            |
| Coverage manifests           | Elevate to a first-class result of every query.                                                                                            |
| Condensed agent instructions | Keep minimal and test against guidance-only controls.                                                                                      |
| Failure scanners             | Defer broad expansion until the exploration substrate passes its gate.                                                                     |

Delete or forbid:

- pairwise persistence candidates;
- ungrounded generic protocol method names;
- function-name wrapper semantics;
- default production traversal through tests and fixtures;
- one scalar confidence score;
- flattened nested-protocol keys;
- path-only HTTP joining across unknown services;
- statement counts presented as semantic fidelity;
- semantic pagination;
- silent rank-based deletion;
- LLM summaries used as source facts; and
- broad multi-language or graph-platform rewrites before the vertical slice earns them.

## Open risks

- A perfect evidence engine cannot compensate for a badly formulated query plan.
- Dynamic languages, reflection, mutation, plugins, and environment configuration impose an exactness ceiling.
- Compact views can create overconfidence and a hidden exact-source verification tax.
- Ecosystem adapters may become expensive even when repositories require no configuration.
- SCIP indexers expose uneven compiler facts across languages.
- Method/path equality without service identity can produce cross-service false links.
- Proof and coverage output can consume the tokens saved by source compression.
- Index freshness must be explicit after source edits; stale facts must be invalidated or downgraded.
- One task, repository, or model cannot establish generality.

The current central decision is therefore: build selection and runtime navigation on a demand-driven, provenance-carrying evidence compiler; treat protocols as exact projections over shared symbol and value primitives; and require every abstraction to earn its place by reducing tokens-to-correct-answer under an accuracy gate.
