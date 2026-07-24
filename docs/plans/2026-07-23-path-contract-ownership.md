# Project-Path Contract Ownership Plan

Date: 2026-07-23

## Goal

Move the project-wide path-equivalence contract from `source` to the closed
`domain` leaf, preserving every function and consumer while removing the
`resolution -> source` half of the one-edge reciprocal relationship.

## Definitions and Invariants

A project-path contract is a dependency-free convention whose referents are
repository-relative paths, separator normalization, path equivalence, and
project containment. It is distinguished from source extraction by defining
what project paths mean for every subsystem rather than reading or interpreting
source text. Source: `scip-query plan-context
src/source/path-normalization.ts`, `scip-query code
'src/source/path-normalization.ts:1-27'`.

Path equivalence is the relation in which two project-relative strings denote
the same path after backslash-to-slash and leading-`./` normalization. Its
referents are `normalizeRelativePath()` and `pathsResolveSame()`. Source:
`scip-query outline src/source/path-normalization.ts`.

Invariants:

- I1. The four exported functions must always return the same result for every
  input before and after relocation.
- I2. Every current consumer must always import exactly one definition.
- I3. `domain` must always have zero outgoing internal dependencies.
- I4. The slice is complete iff `resolution -> source` disappears and
  `source -> resolution` remains the only direction between those boundaries.
- I5. Moving the contract must not introduce a previously absent boundary pair.
- I6. `resolution -> X` is allowed iff `X` is `domain`, `storage`, or
  `symbols`.

## Premises

- P1. The module contains four functions in 27 lines and depends only on
  `node:path`; it has no internal project dependency. Source: `scip-query code
'src/source/path-normalization.ts:1-27'`, `scip-query deps
src/source/path-normalization.ts`.
- P2. Its complete consumer set contains 14 files across analysis,
  language-parsers, queries, reindex, resolution, symbols, and TLA. Source:
  `scip-query rdeps src/source/path-normalization.ts`.
- P3. `resolution/import-path-resolver.ts` is the sole `resolution -> source`
  file edge, while `source/vue/vue-profile.ts` is the sole
  `source -> resolution` file edge. Source: `scip-query architecture --json`.
- P4. Domain currently contains dependency-free config, finding, maintenance,
  numeric parsing, query option, and symbol contracts, with a closed empty
  dependency row. Source: `scip-query system src/domain`, `.scipquery.json`.
- P5. Source, analysis, language-parsers, queries, reindex, symbols, and TLA
  already depend on domain; resolution is the only consumer boundary for which
  the move replaces a source dependency with a domain dependency. Source:
  `scip-query architecture --json`.
- P6. Similar-file and co-change queries find no competing owner or historical
  locality obligation for the module. Source: `scip-query similar-files
src/source/path-normalization.ts --json --full`, `scip-query co-change
src/source/path-normalization.ts --json --full`.
- P7. After the move, the complete outgoing resolution targets are `domain`
  for project paths, `storage` for indexed evidence, and `symbols` for symbol
  lookup; resolution has no reciprocal boundary pair. Source: `scip-query
architecture --json`.

## Reuse and State Audit

Relocate the existing module intact. Do not introduce a new path wrapper,
barrel, compatibility re-export, or duplicate normalizer: the four existing
functions are the complete contract (P1-P2).

The functions read their arguments and `node:path` only. There are no shared
state writers or readers to migrate (P1).

## Testability Design

| Behavior                | Test seam                  | Dependencies   | Pure core                  | Side-effect shell | Contract                  |
| ----------------------- | -------------------------- | -------------- | -------------------------- | ----------------- | ------------------------- |
| Relative normalization  | Existing exported function | None           | Entire function            | None              | String to string          |
| Separator normalization | Existing exported function | None           | Entire function            | None              | String to string          |
| Path equivalence        | Existing exported function | None           | Entire function            | None              | Two strings to boolean    |
| Project containment     | Existing exported function | `node:path`    | Decision over `relative()` | None              | Root/candidate to boolean |
| Ownership               | `architecture --json`      | Compiler index | Boundary graph             | Index read        | One-way source/resolution |

## Implementation Steps

### 1. Relocate the contract and all consumers

- [x] **Files**: `src/source/path-normalization.ts`, its 14 consumers, and any
      config records that name the old path
- **Premises**: P1-P6
- **Deployable**: yes
- **Change**: Move the file to `src/domain/path-normalization.ts` without
  changing its exports or bodies. Update the complete consumer set and any
  path-specific suppression or coupling record directly; leave no forwarding
  module.
- **Testability**: existing exports and affected query/source suites.
- **Validation**: old-path search, typecheck, focused tests, reindex,
  architecture, and incomplete-migration.

### 2. Close the repaired resolution boundary

- [x] **Files**: `.scipquery.json`
- **Premises**: P3-P5, P7
- **Deployable**: yes, after step 1
- **Change**: Add the closed resolution row
  `["domain", "storage", "symbols"]` only after the rebuilt graph confirms that
  these are the complete intended targets.
- **Testability**: configuration validation and the default architecture gate.
- **Validation**: `config-validate`, `drift --architecture`, and `diff-gate`.

## Counterexample Attacks

### A1. Resolution behavior changes during ownership cleanup

- Attack: Windows-style and leading-`./` import paths pass through resolution
  after the move.
- Outcome: HELD — step 1 moves function bodies intact (P1, I1).

### A2. Partial consumer migration

- Attack: one of 14 importers keeps the old specifier after the source file is
  deleted.
- Outcome: HELD — step 1 uses the complete reverse-dependency set and validates
  typecheck plus old-path search (P2).

### A3. Domain acquires an outgoing dependency

- Attack: the move preserves a hidden source import and violates the closed
  domain row.
- Outcome: HELD — P1 proves no internal dependency, and the architecture gate
  in step 1 enforces I3.

### A4. New pair replaces the removed cycle

- Attack: a consumer boundary that did not depend on domain begins doing so,
  preserving the same cycle under another target.
- Outcome: HELD — P5 identifies resolution as the only new domain consumer;
  domain has no reverse edge.

### A5. Compatibility wrapper preserves the old ownership

- Attack: a forwarding file remains in source, so resolution still imports
  source and the graph does not improve.
- Outcome: HOLE — repaired by step 1 forbidding a forwarding file and updating
  all consumers atomically (P2-P3).

### A6. Path-specific repository record becomes stale

- Attack: a suppression or declared-coupling entry still names the moved file,
  causing configuration warnings.
- Outcome: HOLE — repaired by step 1 searching and updating path-specific
  records before configuration validation.

### A7. Resolution gains a new accidental dependency

- Attack: a later path resolver imports runtime or source policy after the
  reciprocal edge is removed.
- Outcome: HOLE — repaired by step 2 closing resolution over its three proved
  mechanism targets (P7, I6).

| Surface or lens           | Attacks |
| ------------------------- | ------- |
| Four path functions       | A1, A3  |
| Fourteen consumers        | A2, A4  |
| Domain closed row         | A3, A4  |
| Resolution/source pair    | A4, A5  |
| Resolution enforcement    | A7      |
| Configuration records     | A6      |
| Valid intermediate state  | A2, A5  |
| Reversibility and failure | A1, A2  |
| Reuse                     | A5      |
| Testability               | A1-A4   |

## Verdict

Result: **PLANNED-COMPLETE** — 7 attacks, 3 holes repaired, 0 holes accepted;
all consumers and applicable lenses are covered.
