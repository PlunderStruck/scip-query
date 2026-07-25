# Windows Sidecar Publish Hook Repair

Date: 2026-07-24

## Goal

Make one `npm publish` of the main package publish the Windows sidecar first,
while guaranteeing that `npm publish --dry-run` and direct validation never
write to the registry.

## Definitions & Invariants

The main-package publish lifecycle is npm's process context for
`prepublishOnly`; its essential trait here is that `npm_lifecycle_event` names
the outer release action. Source: the observed `npm publish --dry-run` output
and `scripts/publish-scip-windows.ts`.

The Windows sidecar is the OS-gated npm package containing the two `scip.exe`
binaries; its essential trait is that the main package can install Windows
SCIP support without shipping those binaries to other operating systems.
Source: `packages/scip-windows/package.json` and the main package's
`optionalDependencies`.

- A real main-package publish must always reach the sidecar's registry check
  with `npm_lifecycle_event=prepublishOnly`.
- A dry-run must never execute `npm publish` in the sidecar directory.
- A direct `npm run publish:scip-windows` must validate/build but must never
  publish.
- The optional-dependency version and sidecar package version must always
  match before either package can publish.

## Premises

- **P1.** The release script is outside the SCIP index, so `scip-query
  plan-context scripts/publish-scip-windows.ts --json` returns no matched
  symbol or file. Raw release-script and package-manifest evidence is therefore
  the narrowest available source.
- **P2.** `prepublishOnly` currently runs `npm run publish:scip-windows`, which
  starts a nested npm lifecycle. Source: `package.json`.
- **P3.** The sidecar script publishes only when
  `npm_lifecycle_event === "prepublishOnly"`; otherwise it prints that the
  invocation is direct. Source: `scripts/publish-scip-windows.ts`.
- **P4.** The executed `npm publish --dry-run --json` entered
  `prepublishOnly`, then the nested script printed “direct invocation,” proving
  that P2 overwrites the event P3 needs.
- **P5.** The same script already implements version-pin validation, missing
  binary construction, dry-run suppression, and idempotent registry lookup.
  Source: `scripts/publish-scip-windows.ts`.
- **P6.** `tests/scripts/windows-sidecar-doc.test.ts` is the existing
  sidecar-release contract test. Source: repository test search; the release
  script itself is not indexed per P1.

The only shared state is npm's lifecycle environment. npm writes
`npm_lifecycle_event` and `npm_config_dry_run`; the sidecar script is their only
repository reader. The registry is written only by the script's sidecar
`npm publish` subprocess and read by `alreadyPublished`.

## Current State

The outer publish enters `prepublishOnly`, but P2 starts another npm lifecycle.
That nested process replaces the outer event, so P3 takes the manual-validation
branch even during a real release (P4). All lower-level safety behavior is
already present and should be reused (P5).

## Reuse Audit

Reuse `scripts/publish-scip-windows.ts` unchanged. Replace only the nested npm
script hop with a direct `vite-node` invocation and extend the existing
sidecar contract test (P5, P6). No new helper, option, wrapper, module, or
environment variable is justified.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Preserve outer lifecycle | package-script assertion | none | manifest string check | npm lifecycle | `prepublishOnly` invokes `vite-node` directly |
| Dry-run skips registry writes | `npm publish --dry-run --json` | npm dry-run environment | existing branch decision | npm/build subprocesses | output says it would publish, then skips |
| Direct validation stays non-publishing | `npm run publish:scip-windows` | direct npm lifecycle | existing branch decision | binary checks | output identifies direct invocation |

## Design Phase

### 1. Repair the lifecycle wiring

- [ ] **Files**: `package.json`, `tests/scripts/windows-sidecar-doc.test.ts`
- **Premises**: P2-P6
- **Deployable**: yes
- **Change**: make `prepublishOnly` call
  `vite-node scripts/publish-scip-windows.ts` directly before the build; assert
  that exact relationship and forbid the nested npm hop.
- **Testability**: use the existing contract test and both executed npm paths
  in the table above.
- **Validation**: targeted test, direct validation command, and publish
  dry-run.

## Attack Record

### A1. Real publish is mistaken for manual validation

- **Attack**: maintainer runs `npm publish`; `prepublishOnly` starts nested npm;
  nested lifecycle replaces the outer event; sidecar is skipped.
- **Outcome**: **HOLE — repaired by step 1** (P2-P4).

### A2. Dry-run accidentally publishes the sidecar

- **Attack**: maintainer runs `npm publish --dry-run`; direct script sees
  `prepublishOnly` but must honor npm's dry-run flag.
- **Outcome**: **HELD** by existing dry-run branch and step 1 validation (P5).

### A3. Manual validation accidentally publishes

- **Attack**: contributor runs `npm run publish:scip-windows`; its lifecycle
  event is `publish:scip-windows`.
- **Outcome**: **HELD** by the existing direct-invocation branch (P3, P5).

### A4. Repeated release republishes an existing sidecar

- **Attack**: registry already contains the exact sidecar version; maintainer
  retries main publish.
- **Outcome**: **HELD** by `alreadyPublished` (P5).

### A5. Main and sidecar versions diverge

- **Attack**: maintainer bumps one manifest but not the optional-dependency
  pin, then publishes.
- **Outcome**: **HELD** by the existing equality guard (P5).

| Surface or lens | Attacks |
| --- | --- |
| npm lifecycle writer | A1-A3 |
| lifecycle reader | A1-A3 |
| registry reader/writer | A2-A4 |
| manifest version authority | A5 |
| missing-binary build path | A2, A3 |
| failure and retry | A4, A5 |
| testability | A1-A3 |

## Execution and Ship Order

Apply step 1 as one deployable change. Run the targeted test, direct validation,
and publish dry-run before any real registry action. Publishing remains a
separate, user-authorized one-way door.

## Verdict

A plan is **PLANNED-COMPLETE** iff every attack has a cited defense or recorded
repair and the coverage matrix has no blank row.

Result: **PLANNED-COMPLETE** — 5 attacks, 1 hole repaired, 0 accepted holes.

Files: add this plan; edit `package.json` and
`tests/scripts/windows-sidecar-doc.test.ts`; delete nothing.
