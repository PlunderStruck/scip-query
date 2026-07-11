# Python detector certification

Date: 2026-07-11

Verdict: **Python output is qualified, insufficiently evidenced, or
unsupported. No Python detector is certified for public actionable scoring.**

## What this certificate means

A Python detector is a command that interprets Python source and its SCIP
index to report a code fact or an investigation signal. Python decorators,
runtime registration, module export metadata, protocol methods, dynamic
attribute access, and framework discovery can make a callable live without an
ordinary direct reference. The available Python index and source parser expose
many relationships, but this build has no Python semantic provider and no
type-aware Python checker. A semantic provider is a language-aware resolver
that identifies what a name denotes after imports, inheritance, and language
rules are applied; a checker is an independent program that rejects invalid
code after a proposed change. `python -m compileall` checks syntax only and is
not a semantic checker.

`qualified` below means the command reports a reproducible source, Git, or
indexed-graph relationship under a narrower stated contract. `insufficient`
means an implementation path exists but the natural population or independent
oracle is too weak for a precision or completeness claim. `unsupported` means
the implementation does not analyze Python for that command. An unavailable
capability is never counted as a successful zero.

## Pinned corpus and capability

The audit used isolated read-only worktrees and checkout-local caches:

| Repository     | Commit                                     | Role                                                                                      | Python capability                                                                                            |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| scip-python    | `e02c96e17078e701639d533ec1baa57468d0215b` | indexer/syntax corpus with 1,077 Python test samples, not a natural production population | index and source available; semantic provider and checker unavailable                                        |
| traceroot      | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` | FastAPI, Pydantic, and Celery production corpus                                           | partial mixed-language index available; Python semantic provider unavailable; `compileall` syntax check only |
| PaddOCR_Client | `dee9dd4d31e7f4b3c7b4038957ffeb39c0df6aa3` | four-file Flask holdout                                                                   | index and source available; semantic provider and checker unavailable                                        |

`scip-python-plus` indexed all three Python populations. Traceroot's C++ shard
could not index without a compilation database, so its successful run used
`reindex --allow-partial` and explicitly retained TypeScript and Python while
skipping C++. That failure is not converted into a clean cross-language result.

## Replay inventory

| Analyzer                 | Traceroot / Flask observation                                                              | Verdict      | Contract and boundary                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------- |
| `dead`                   | traceroot: 2 repository-dead, 64 file-internal; Flask: 0 repository-dead, 29 file-internal | insufficient | direct indexed liveness after protocol/export hardening; dynamic and framework completeness unavailable |
| `unused-imports`         | traceroot: 0 after 15 `__all__` export false positives were corrected                      | qualified    | source binding-use fact including literal `__all__`; implicit/dynamic import completeness unavailable   |
| `unused-params`          | not analyzed                                                                               | unsupported  | implementation is explicitly TS/JS-only                                                                 |
| `cycles`                 | supported zeros                                                                            | insufficient | source/index dependency graph exists; no natural positive or independent exhaustive oracle              |
| `duplicate-bodies`       | supported zeros                                                                            | insufficient | normalized source equality path exists; no natural Python population                                    |
| `complexity`             | fixture/source backed                                                                      | qualified    | source branch measurement; metaprogrammed behavior is outside the frame                                 |
| `isolated`               | supported zeros                                                                            | insufficient | no natural positive population and no semantic completeness                                             |
| `redundant-reexports`    | not analyzed                                                                               | unsupported  | implementation models JS/TS barrels, not Python module exports                                          |
| `not-implemented`        | not analyzed                                                                               | unsupported  | placeholder syntax and reachability model are JS/TS-specific                                            |
| `decorative-checkers`    | not analyzed                                                                               | unsupported  | callable/failure scan is JS/TS-specific                                                                 |
| `test-quality`           | not analyzed                                                                               | unsupported  | test source scan is restricted to JS/TS extensions                                                      |
| `recent-duplicates`      | 0                                                                                          | insufficient | supported run, no natural relationship population                                                       |
| `similar`                | 0                                                                                          | insufficient | supported run, no natural relationship population                                                       |
| `similar-files`          | 0                                                                                          | insufficient | supported run, no natural relationship population                                                       |
| `similar-chains`         | traceroot: 1,994 bounded relationships                                                     | qualified    | indexed path-overlap fact within the command's internal bound; not consolidation advice                 |
| `similar-signatures`     | traceroot: 11; Flask: 2                                                                    | qualified    | callable signature-shape equality from SCIP; refactoring utility is contextual                          |
| `twin-drift`             | 0 after convention-only `__init__` grouping was removed                                    | insufficient | supported zero plus regressions; no natural positive population                                         |
| `co-change`              | 44 repository pairs over 1,799 commits                                                     | qualified    | exact Git co-change history; design coupling is contextual                                              |
| `doc-drift`              | 21 rows over 105 docs                                                                      | qualified    | citation/change-order history; priority remains contextual                                              |
| `drift`                  | 2 inferred layer edges                                                                     | qualified    | dependency edges are factual; the layer policy and action are signals                                   |
| `wrapper-candidates`     | 2 rows                                                                                     | qualified    | disclosed single-caller relationship; decorator/runtime boundaries still require review                 |
| `passthrough-candidates` | 0                                                                                          | insufficient | supported run, no natural positive population                                                           |
| `stale-abstractions`     | 0 after two live model families were corrected                                             | insufficient | low-consumer path exists; dynamic/framework completeness unavailable                                    |
| `extract-candidates`     | 0                                                                                          | insufficient | supported measurement, no natural positive population                                                   |
| `locality-candidates`    | 39 rows                                                                                    | qualified    | disclosed ownership/destination relationship; movement remains contextual                               |
| `coupling`               | 108 rows                                                                                   | qualified    | exact shared indexed-symbol sets                                                                        |
| `bottlenecks`            | 3 rows                                                                                     | qualified    | disclosed graph centrality; refactoring utility remains contextual                                      |
| `deep-chains`            | 15 rows                                                                                    | qualified    | condensed indexed dependency paths                                                                      |
| `complexity-hotspots`    | 310 rows                                                                                   | qualified    | composite source/index measurement, not a defect verdict                                                |
| `hotspots`               | 219 rows                                                                                   | qualified    | indexed reference counts                                                                                |
| `fan-in`                 | 58 rows                                                                                    | qualified    | exact indexed-symbol reference counts, not runtime reachability                                         |
| `fan-out`                | 36 rows                                                                                    | qualified    | exact indexed external-symbol counts                                                                    |

React, Vue, and `augment-vue` analyzers are unsupported for Python by design.

## Defects found and corrected

The campaign found five Python-specific false-positive families:

1. Convention-only dunder names such as `__init__` were grouped as divergent
   twins. Python protocol dunders are now excluded from twin advice.
2. Pydantic response and source models reached through chains of annotations
   and inheritance were called stale. Python superclass edges are now present,
   and liveness traverses the full same-file type graph rather than one hop.
3. Runtime protocol hooks and `__all__` metadata appeared repository-dead.
   Python dunder hooks and module export metadata are explicitly preserved.
4. Imports intentionally re-exported by literal `__all__` lists or tuples were
   called unused. The source import oracle now recognizes those bound names.
5. The first three corrections could have hidden general relationships, so the
   Flask holdout was replayed: it retained 29 file-internal relationships and
   two source-valid signature relationships while reporting zero
   repository-dead symbols.

Focused regression tests cover each corrected archetype. The remaining two
traceroot repository-dead rows have source evidence but cannot be certified as
deletions without a semantic provider and type-aware checker.

## Framework applicability

- FastAPI route decorators were present and did not create reviewed dead-code
  findings, but this is observed corpus behavior, not a general decorator
  completeness guarantee.
- Pydantic model inheritance and nested annotation consumption are protected
  by the corrected type graph.
- Celery task registration and Flask route registration remain runtime
  discovery boundaries. Their absence from findings does not certify recall.
- Django, pytest fixture injection, Click/Typer registration, dataclasses, and
  arbitrary user decorators did not receive a representative natural
  population in this audit. They remain not certified rather than silently
  excluded or declared clean.

## Publication decision

Python relationships are suitable for a private cloud shadow only when each
row carries its capability and verdict. They are not ready for a public defect
score or deletion recommendation. In particular, source/index graph facts may
be shown as observed relationships, while `dead`, stale, and other liveness
claims must remain private until a Python semantic provider, a type-aware
checker, and broader decorator/framework recall evidence exist.

Machine-readable verdicts:
[`2026-07-11-python-detector-certification-verdicts.json`](./2026-07-11-python-detector-certification-verdicts.json).
