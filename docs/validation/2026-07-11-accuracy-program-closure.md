# Accuracy verification program closure

Date: 2026-07-11

Verdict: **the certified evidence views and explicitly qualified signals are
ready for a private cloud shadow with preserved capability and provenance
records. The aggregate health score and cross-language leaderboard are not
ready for public comparison.**

## What closed

An accuracy certificate is a reproducible classification of what one command
can establish from a named corpus, fixture, compiler/index/source oracle, and
visible capability state. What makes it different from a green test is that it
records both the supported claim and the conditions that can make the answer
incomplete. This program assigned that classification to every public command
row and every TypeScript, Rust, and Python detector cell in the audit matrix.

There are no pending or unexplained command rows. A terminal state may be
`certified`, `qualified`, `insufficient`, `experimental`, `unsupported`, or
alias `parity`; only `certified` rows meet the public actionable-finding
threshold. Supported zeros, failed indexing, unavailable semantics, and absent
natural populations were not converted into evidence of accuracy.

## Final verification

The exact final verification sequence produced:

| Gate | Result |
| --- | --- |
| Full tests | 188 files, 1,318 tests passed |
| TypeScript typecheck | passed |
| Prettier, ESLint, and skill-link lint | passed |
| Distribution build and declarations | passed |
| Reindex | TypeScript and Rust reused; current generation in about 0.3 s |
| Full health | score 80; explicitly `experimental-composite`, completed-analyses-only, non-comparable across languages |
| Capability matrix | TypeScript and Rust indexing, semantics, and reference-aware cleanup verification available |
| Doc drift | 614 docs scanned over 494 commits; 72 review signals and zero broken references after correction |
| Diff gate | exit 0, zero blocking findings, zero advisories |

The 72 doc-drift rows are history/citation review signals, not 72 broken docs.
The final broken-reference count is the exact closure condition used here.

## Before/after evidence

| Surface | Before | After | Decision |
| --- | --- | --- | --- |
| TypeScript `dead` | 25/78 valid, 32.1% precision, 22.7% Wilson floor | 43/43 valid across four repositories, 91.8% Wilson floor | certified |
| Rust `dead` | 1/52 valid in the original baseline | 3/3 valid natural findings across the widened replay, 43.9% Wilson floor | insufficient population; not promoted |
| React/Vue detectors | no completed publication certificate | 297 reviewed relationship/measurement rows across six families, all source-valid under their stated truth rules | measurements/relationships certified; refactoring utility contextual |
| Composite workflows | health could omit capability state and turn relationships into actions | 166 probes passed; capability matrix attached; score marked experimental; wording requires investigation | private shadow only |
| Navigation call graph | import, type-reference, and module owners could appear as callers | 107 probes plus live replay; incoming callers require callable owners | qualified exact indexed/source relation |
| Operational capability | syntax-only Python `compileall` appeared fully available | checker strength is explicit; syntax-only and mixed-project verification are partial | qualified honest disclosure |
| Vega TypeScript caller computation | 36.94 s precise historical control | 13.81 s exact cold fragments and 4.16 s unchanged warm fragments with the same normalized findings | accepted performance path |
| Current self-repository indexing | no closure measurement | 4.35 s cold, 357 ms warm, 156 ms `stats` on 328 files/22,318 symbols | environment-local measurement |

The Vega performance comparison belongs to the preceding indexing/analysis
campaign but is carried here because the accuracy audit verified that the
faster fragment path preserved the exact caller relation consumed by `dead`.

## Discriminating probes

The program did not rely on ordinary green fixtures alone. It planted or
replayed failures that could distinguish an honest implementation from a
plausible stub:

- private TypeScript twins, adjacent export declarations, incompatible
  signatures, and compilable generated A/B scaffolds;
- Rust traits, implementations, convention names, grouped imports, implicit
  trait use, derive/macro/public-surface boundaries, and untouched holdouts;
- Python dunders, Pydantic model graphs, runtime protocol hooks, literal
  `__all__`, decorated registrations, and explicit absence of a semantic
  provider;
- each diff-gate family with a bounded failing mutation, followed by removal
  and a quiet replay;
- module imports and type references retained in reference answers but rejected
  as callable call-graph owners;
- corrupt fragments/generation state, injected publication failures, old/new
  SQLite readers, concurrent refresh locks, service idle/wake, local hook Git
  exclusion, and caught→resolved/suppressed ledger transitions;
- legal and illegal real TLC traces plus swapped TLA action/code mappings; and
- a final doc-drift broken reference whose stale generator would have recreated
  obsolete Windows release instructions.

## Deviations and corrections

- The user requested one-agent execution for the long campaign. No sub-agents
  were used; the program ran sequentially on `main` with coherent commits.
- The original plan allowed certification where evidence supported it. Natural
  populations did not support every promotion. Rust `dead`, several low-volume
  TypeScript detectors, and all strong Python semantic claims therefore remain
  insufficient or unsupported rather than receiving manufactured examples.
- Health is retained as a useful private composite summary, but its score is
  not normalized across languages/frameworks. The implementation now says so
  in the payload and warnings.
- A late doc-drift replay found the Windows sidecar README and its generator
  referring to a deleted download module. Both now describe the actual npm
  sidecar release path, with a regression contract.

## Folded-back learning

- Capability is part of every result's meaning. A zero without indexing,
  semantic, framework, and checker state is not a clean result.
- Measurements and relationships can be exact while the proposed action is
  contextual. Output schemas and health wording must preserve that distinction.
- Cache speedups are acceptable only when their work identity includes every
  input that can change the answer and a cold oracle proves payload parity.
- Operational records have two owners: local hook preferences belong to the
  checkout, while suppressions and effectiveness events belong to repository
  history. Setup and uninstall now preserve that boundary.
- A final verifier must inspect discriminating fields—broken-reference counts,
  capability cells, warning semantics, and gate findings—not merely process
  exit codes.

## Private shadow contract

A private cloud shadow may publish certified evidence views and show qualified
signals if every run preserves:

- repository URL and immutable commit;
- scip-query/package/indexer versions and configuration;
- language, semantic, source-fallback, framework, and checker capability rows;
- accepted SQLite generation identity and raw command output;
- detector truth-rule/certificate version, suppression state, and outcome
  ledger transitions; and
- explicit `not analyzed`, `partial`, `insufficient`, and `unsupported` states.

It must not rank repositories by the current aggregate health score. Public
leaderboard design requires a separate program for comparable cohorts,
versioned metric families, missing-capability treatment, rerun policy, abuse
resistance, and publication/retraction rules.

## Explicit deferrals

- a Python semantic provider and type/reference-aware framework coverage;
- public cross-language score normalization and leaderboard operations;
- compiler overload selection, true inheritance/value/control flow, and
  semantic cross-language graph edges;
- private-callable `twin-ab` scaffolding;
- natural-population renewal for rows currently marked insufficient; and
- performance roadmap items that do not alter accuracy, including broader
  multi-project incremental compiler-fragment publication.

Machine-readable closure:
[`2026-07-11-accuracy-program-closure-verdict.json`](./2026-07-11-accuracy-program-closure-verdict.json).
