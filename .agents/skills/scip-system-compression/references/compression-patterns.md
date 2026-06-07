# Compression Patterns

Use this reference after the first evidence pass, when generating possible simplification models. These are prompts for thought, not templates to impose.

## Atlas-First Compression

Use when the user wants to think ahead across a whole repository, module family, command surface, query family, or subsystem before editing. The real referents are source files, symbols, command handlers, query modules, docs, tests, generated artifacts, and previously discovered opportunities that could interact. The deeper pattern is that discovery and ordering must be completed before implementation, so local opportunities are not rediscovered as new work after each edit.

Typical compression: build a compression atlas with an opportunity ledger and deferred register, cluster by root cause, order clusters by enabling power, enrich steps, sense-check overlap and value, then execute the unblocked clusters in dependency order even when the right cleanup is large.

Reject when the scope is a single isolated bug or one clearly bounded refactor where a full atlas would add planning overhead without reducing rework risk.

## Metadata-Rendered Surface

Use when command help, docs, examples, tests, and runtime behavior all describe the same external surface. The real referents are command registrations, option definitions, usage text, README sections, snapshots, and smoke tests. The deeper pattern is that hand-maintained text should become a rendered view of executable metadata.

Typical compression: introduce a command descriptor or schema that owns name, arguments, options, examples, analysis function, and renderer hooks; generate help/docs/tests from it where practical.

Reject when docs intentionally teach concepts that cannot be derived from command metadata.

## Pipeline

Use when many flows repeatedly parse input, load state, run analysis, transform results, render output, and handle errors. The real referents are command actions, scripts, batch jobs, worker handlers, and tests that assert their outputs. The deeper pattern is one lifecycle with different stages plugged in.

Typical compression: make the lifecycle explicit, keep stage functions small, and move policy decisions into named stage inputs instead of scattered inline code.

Reject when the flows have materially different ordering, resource lifetime, or error semantics.

## Registry or Descriptor Table

Use when many branches select behavior by name, language, kind, command, file type, or analysis phase. The real referents are switch statements, if chains, command builders, language dispatch, test matrices, and documentation tables. The deeper pattern is a finite set of cases with shared fields and per-case functions.

Typical compression: replace scattered branches with a typed table of descriptors and one executor that consumes the table.

Reject when the table becomes a bag of unrelated optional fields.

## Execution Algebra

Use when a descriptor table centralizes names and metadata but leaves many handlers repeating the same lifecycle. The real referents are command handlers, API handlers, worker phases, query calls, renderers, option decoders, budget checks, and hidden commands. The deeper pattern is that each unit is an instance of one of a few execution shapes.

Typical compression: define typed command shapes such as pure query, heuristic query, project readiness, lifecycle side effect, and isolated worker. Each shape owns its required setup order, allowed variant points, result renderer, and error behavior. Descriptors choose a shape instead of pointing at a bespoke handler whenever possible.

Reject when shape variants require many unrelated escape hatches, or when lifecycle order differs enough that a custom handler is clearer.

## Shared Policy Object

Use when separate modules answer the same rule question differently, such as "what is live?", "what is public?", "what is ignored?", "what counts as a test?", or "which edge is real?" The real referents are repeated predicates, SQL fragments, filters, option defaults, and tests that encode the same domain boundary. The deeper pattern is one policy that multiple analyses should import.

Typical compression: name the policy in domain language, centralize it in a narrow module, and make each caller pass only the context it actually owns.

Reject when the apparent rule is only similar because the words are similar; user-visible behavior may require separate policies.

## Query Algebra

Use when query modules repeatedly build the same graph, candidate set, scoring pass, or summary rows before applying different final filters. The real referents are SQL fragments, graph builders, row mappers, symbol classifiers, candidate gates, and report summaries. The deeper pattern is a small vocabulary of query operations that can be composed.

Typical compression: factor the repeated operation as a named data transformation with explicit inputs and outputs; keep command-specific ranking and rendering outside it.

Reject when a generalized operation hides expensive work or makes precision/confidence rules less visible.

## Adapter-Core Split

Use when UI, CLI, API, or worker code owns business logic while pure modules merely support it. The real referents are command actions, HTTP handlers, worker messages, renderers, and pure query functions. The deeper pattern is that adapters translate boundaries while the core owns analysis.

Typical compression: move behavior into pure functions with typed results; make adapters responsible only for input parsing, resource setup, output formatting, and exit behavior.

Reject when moving logic would destabilize a public surface without reducing duplicated policy.

## Compatibility Shell

Use when old APIs, scripts, command names, or file paths remain only to preserve callers after the real implementation moved. The real referents are wrappers, aliases, barrels, deprecated modules, and release notes. The deeper pattern is a temporary shell around a new center.

Typical compression: keep the shell thin, document the compatibility boundary, and delete it when references prove it is no longer used.

Reject when the wrapper adds meaningful validation, translation, or lifecycle management.

## Anti-Patterns

Helper cemetery: a refactor extracts many tiny helpers but leaves the original concepts scattered.

Parameter swamp: one generic function gains many flags because the grouped cases are not actually the same kind of thing.

False center: a new module becomes a dependency hub without owning a coherent policy or workflow.

Name-level unification: code is grouped because names sound similar, while call graphs, data flow, or user-visible behavior show different roles.

Premature deletion: code is removed because it looks conceptually redundant before references, entry points, and tests prove it is unused or replaceable.
