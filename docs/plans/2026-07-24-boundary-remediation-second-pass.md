# Boundary Remediation Second Pass

Date: 2026-07-24

## Goal

Preserve the repaired 34-boundary architecture without weakening unrelated
boundaries, losing newly introduced internal cycles, or leaving the normative
architecture record inconsistent with enforcement.

A boundary-specific file ceiling is an architecture size rule attached to one
configured ownership boundary. Its defining trait is that it overrides the
project-wide default only for the named responsibility whose intentional size
has been reviewed.

A coarse-cycle cardinality identity is a persistent baseline key representing
the number of independent strongly connected subgraphs hidden inside one
boundary. Its defining trait is that membership changes within an existing
cycle do not churn the key, while an additional independent cycle creates an
additional key.

A hierarchy-file classifier is a predicate that separates structural module
wiring from files that own executable or analytical decisions. Its defining
trait is evidential: path shape alone may identify tests and entry points, but
only content can establish that an `index.ts` or `mod.rs` file is a pure barrel.

## Invariants

- `maxBoundaryFiles: 40` applies to every boundary without its own `maxFiles`.
- The intentional 52-file `source` boundary has `maxFiles: 60`; no other
  boundary inherits that exception.
- Coarse-cycle identities remain unchanged when one cycle's membership changes
  but gain one identity when a second independent cycle appears.
- The exported detector's default classifier never discards a logic-bearing
  `index.ts` merely because of its filename.
- Every configured boundary has one documented responsibility, and the
  originating execution plan records the remediation that superseded its
  source split.

## Evidence and Reuse Audit

- **P1**: `.scipquery.json` intentionally merges `src/source/**` and
  `src/language-parsers/**` into `source`.
- **P2**: `boundaryLimits()` currently applies one scalar
  `maxBoundaryFiles` to every configured boundary.
- **P3**: `architectureFindingIdentities()` currently collapses every internal
  strongly connected component in a boundary to one key.
- **P4**: `detectCoarseBoundaries()` defaults to a path-only classifier that
  treats every `index.ts` and `mod.rs` as a barrel; `architecture(db)` already
  supplies the content-aware classifier.
- **P5**: the target architecture completion criterion requires one
  responsibility for every mapped boundary, but its table still lists the old
  coarse boundary families.

Extend `ArchitectureBoundaryConfig` and the existing `boundaryLimits()` seam;
do not create a parallel limit subsystem. Extend the existing identity writer
with cardinality keys; do not encode changing component members. Tighten the
existing default classifier; production keeps its content-aware override.

## Testability

| Behavior | Pure seam | Contract |
| --- | --- | --- |
| Per-boundary file ceiling | `analyzeArchitectureGraph` | local `maxFiles` overrides the global ceiling for one boundary |
| Config validation | `validateProjectConfig` | invalid local ceilings produce a path-specific error |
| Stable and complete identities | `architectureFindingIdentities` | membership growth is stable; component-count growth is new |
| Safe default classification | `detectCoarseBoundaries` | a logic-bearing `index.ts` remains in the graph by default |
| Documentation completeness | architecture/config comparison | all 34 configured names have responsibility rows |

## Implementation

1. Add validated `ArchitectureBoundaryConfig.maxFiles` and apply it before the
   global `maxBoundaryFiles`; restore the global ceiling to 40 and give only
   `source` a ceiling of 60.
2. Emit the stable boundary identity for the first coarse component and
   `component:2`, `component:3`, and so on for additional components.
3. Make the path-only default exclude only unambiguous tests and entry points;
   leave barrel exclusion to the injected content-aware classifier.
4. Reconcile the target architecture table and the originating plan's
   execution outcome with the enforced 34-boundary result.

## Adversarial Cases

| Attack | Required result |
| --- | --- |
| `source` contains 52 files with a global limit of 40 | no source violation under its reviewed limit of 60 |
| another boundary grows past 40 | file-limit violation |
| `maxFiles` is fractional, negative, or misspelled | config error |
| one coarse cycle grows from two to three members | the same baseline identity |
| a second disconnected cycle appears in the boundary | a new `component:2` identity |
| a logic-bearing `index.ts` closes a cycle | default detector reports it |
| configured boundary names drift from the document | verification fails the manual name comparison |

## Coverage Verdict

The configuration, detector, ratchet, documentation, and regression-test
surfaces are all assigned above with no unowned behavior. Verdict:
**PLANNED-COMPLETE**.
