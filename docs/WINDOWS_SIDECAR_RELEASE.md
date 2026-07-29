# Windows Sidecar Provenance and Release

The Windows sidecar is the npm package `scip-query-scip-windows` and the two
Windows PE executables it carries. It is a platform-specific optional package
whose distinguishing role is to make the `scip` index converter available on
Windows without placing roughly 40 MB of Windows-only bytes in every
`scip-query` installation.

A sidecar provenance record is the versioned `provenance.json` file committed
under `packages/scip-windows`. It is a build attestation distinguished by
binding one sidecar package version to the exact upstream repository, tag,
immutable source commit, Go toolchain, build flags, Windows target, PE machine,
file size, and SHA-256 of both executable files. The JSON Schema is
`docs/schemas/windows-sidecar-provenance.schema.json`.

## Authority and guarantees

The committed provenance record is the release authority for local sidecar
bytes. The executable files are intentionally ignored by Git because of their
size; file presence alone therefore proves nothing. A release is locally
eligible only when all of these facts agree:

1. The main package pins the exact sidecar package version.
2. `provenance.json` names that package and version.
3. Its repository, tag, Go version, command, flags, and build environment match
   the checked-in build contract.
4. It names exactly the x64 and ARM64 targets.
5. Each file is a PE32+ executable with the target's machine code.
6. Each observed byte size and SHA-256 equals the manifest.

This evidence proves which reviewed build claim belongs to the exact local
bytes. It is not a cryptographic signature by a remote builder. Trust in the
source and toolchain claim comes from producing the record in a clean trusted
environment, reviewing the generated manifest, and committing it with the
release change. Registry-byte identity and partial multi-package publication
are separate contracts implemented by REL-02 and REL-03.

## Rebuild procedure

The build contract currently pins:

- SCIP repository: `https://github.com/scip-code/scip.git`
- SCIP tag: `v0.8.1`
- Go toolchain: `go1.26.4`
- command: `go build -trimpath -ldflags="-s -w" ./cmd/scip`
- environment: `CGO_ENABLED=0`, `GOOS=windows`
- targets: `GOARCH=amd64` and `GOARCH=arm64`

From a clean trusted checkout:

1. Install the pinned Go toolchain.
2. Run `npm run build:scip-windows`.
3. Run `npm run verify:scip-windows`.
4. Review the generated `packages/scip-windows/provenance.json`, README, and
   license change. Confirm the immutable source commit is the intended tag.
5. Run `npm pack --dry-run` inside `packages/scip-windows`. Its `prepack`
   lifecycle verifies provenance before npm computes the tarball.
6. Commit the provenance and release metadata. Do not commit the ignored
   executables.

`SCIP_REPO_URL`, `SCIP_VERSION`, and `SCIP_GO_VERSION` are intentional-update
inputs, not ways to bypass the contract. A changed value makes verification
fail until a rebuild produces reviewed evidence for the new input.

The first provenance-bearing package is `0.13.1`. Published `0.13.0` has the
same executables but lacks `provenance.json`; npm versions are immutable, so
the registry identity gate correctly requires the patch bump instead of
trying to overwrite it.

## Registry identity gate

A packed sidecar identity is the npm package coordinate, exact tarball
SHA-1/SHA-512/size, and decoded provenance bytes observed from one locally
created `.tgz`. What distinguishes it from a version-existence check is that
it identifies the bytes intended for installation, not merely the name under
which some bytes were published.

Before any registry mutation, the release flow:

1. verifies the checked-in binaries and provenance;
2. packs the local sidecar once into a private temporary directory;
3. recomputes the tarball hashes and size instead of trusting npm's JSON
   report;
4. extracts `provenance.json` from the tar archive under a 64 MiB decompression
   ceiling; and
5. requires the packed manifest bytes to equal the reviewed local file.

For an existing version, the flow reads npm's `dist` identity, downloads the
published tarball with lifecycle scripts disabled, recomputes its hashes, and
requires all of the following to agree:

- registry metadata and downloaded tarball SHA-1/SHA-512;
- local and registry package names and versions;
- local and registry tarball SHA-1/SHA-512; and
- local and registry provenance bytes.

An explicit npm `E404` is the only evidence that authorizes the
not-yet-published branch. Authentication failures, timeouts, output-limit
failures, malformed metadata, generic proxy errors, and server failures are
ambiguous registry states and stop the release. Pack and registry commands
have finite 120-second and 30-second deadlines respectively, a 4 MiB captured
output ceiling, and typed timeout/output/exit failure classification.

Run `npm run verify:scip-windows-registry` for a read-only reconciliation. It
packs and verifies local bytes, then either proves that the existing registry
tarball is identical or reports that the version is absent and ready for its
first publish. The wrapper passes an explicit verification-only capability;
no inherited environment variable can suppress an authorized release publish.

The complete release coordinator publishes an already verified local `.tgz`,
not a directory that npm could repack differently. If a publish command fails
because another process won the race, the coordinator rereads and downloads
the winning registry version. It may continue only when the winner has the
same complete identity; a different winner requires a new package version.

The historical `npm run publish:scip-windows` alias is now local verification
only. `npm_lifecycle_event`, npm's dry-run environment, and other inherited
environment variables cannot grant it registry mutation authority. The
sidecar-only registry reader has an explicit verification capability, while
the complete coordinator is the only publishing CLI.

## Two-package release coordinator

A two-package release is one ordered publication of an exact main-package
tarball and the exact Windows-sidecar tarball pinned by that main package.
Unlike a database transaction, it cannot roll back an npm publication. Its
essential safety property is therefore not atomicity: it is that every
partial registry state identifies the intended bytes, is observed before the
next irreversible step, and can be reconciled by rerunning one command.

The release coordinator is the repository command that owns this entire
ordering. It differs from a lifecycle hook by packing and validating both
artifacts before either registry mutation, recording local recovery evidence,
and verifying registry truth after each publication:

1. acquire the token-owned release lock;
2. require a clean Git checkout and record the exact `HEAD` object ID;
3. resolve one canonical credential-free HTTPS npm registry and retain it for
   the complete run;
4. run typecheck, the complete test suite, and lint; lint includes formatting,
   production build, API compatibility, downstream compilation, and skill
   link checks;
5. verify provenance and pack the sidecar;
6. pack the main package with lifecycle scripts disabled;
7. extract both packed `package.json` files, require their coordinates, and
   require the packed main tarball to pin the exact packed sidecar version;
8. require Git `HEAD` and complete tracked/untracked working-tree cleanliness
   to be unchanged;
9. durably record the registry and both local tarball identities before
   reading the registry;
10. observe and fully verify both registry coordinates, always passing the
    retained registry URL explicitly, before the first
    publish;
11. publish and verify the sidecar if absent, then durably record that fact;
12. publish and verify the main package if absent, then durably record that
    fact; and
13. remove private packs and release the owned lock.

Every Git, npm pack, registry, publish, test, and lint process has a finite
deadline and captured-output limit. A cleanup or lock-release failure produces
a nonzero outcome without erasing an earlier build, registry, or publication
failure from the diagnostic.

### Operator runbook

Prepare and commit the complete release change first. The checkout must be
clean because the recorded source revision is the wider evidence from which
the two packed artifacts were tested and produced.

1. Bump the main package version. If sidecar bytes or provenance changed, also
   bump the immutable sidecar version and update its exact optional-dependency
   pin.
2. Rebuild and review sidecar provenance when required, following the rebuild
   procedure above.
3. Review and commit the version, lockfile, changelog, provenance, schemas,
   release code, and tests.
4. Run:

   ```bash
   npm run release:npm:dry-run
   ```

   This runs the complete local preflight, packs both artifacts, writes the
   local recovery record, and reads/downloads any existing registry versions.
   It never invokes `npm publish`.

5. Review the reported coordinates, integrities, registry states, and the JSON
   record under `.scipquery/releases/`.
6. Run:

   ```bash
   npm run release:npm
   ```

7. Require the final output to say that both exact registry identities are
   verified. A later retry of the same command is safe: it repeats local
   preflight and registry verification, but it does not republish an already
   identical coordinate.

Do not run `npm publish` directly. The root `prepublishOnly` guard refuses that
path because npm's lifecycle owns only one package publication and cannot
record or recover the pair. An operator can deliberately bypass lifecycle
scripts with npm's `--ignore-scripts` option; that is an administrative
capability outside the repository's enforcement boundary, not an alternate
supported release path. The coordinator itself uses `--ignore-scripts` only
when publishing the two tarballs it has already packed, hashed, inspected,
and recorded.

### Durable local release state

A local release-state record is a schema-versioned JSON recovery fact stored
outside both npm tarballs under `.scipquery/releases/`. It is distinguished
from registry authority by recording what this checkout intended and what an
earlier run verified, while never permitting a later run to skip fresh
registry observation.

Schema version 1 records:

- a content-derived `releaseId`;
- the clean Git revision used for preflight and packing;
- the canonical HTTPS npm registry on which the coordinates are interpreted;
- each package's name, version, byte size, SHA-1, and SHA-512 integrity;
- `createdAt` and nondecreasing `updatedAt` timestamps;
- the writer identity; and
- a canonical set of completed facts:
  `local-preflight-complete`, `sidecar-registry-verified`, and
  `main-registry-verified`.

The registry facts are independent observations, not a fictional transaction
log. For example, an old or manually created state may have the main identity
verified while the sidecar is absent. The next coordinator run still verifies
both coordinates and repairs only the absent intended package.

The path is stable for one pair of package coordinates. Repacking different
bytes, using a different source revision, or selecting a different registry
under those same versions therefore collides with the existing record and
stops before registry work. The record is atomically replaced while the
release lock is owned. The coordinator reports `directory-durable` when the
host synchronizes the containing directory and
`file-flushed; directory sync unsupported` when Windows exposes only the
bounded file guarantee; a real synchronization failure aborts the run. It is
intentionally ignored by Git and omitted from the npm package: it is local
recovery state, not portable release authority. Fresh registry observation,
immutable npm versions, and exact package identity remain the external safety
authority regardless of the local result. The normative shape is
`docs/schemas/npm-release-state.schema.json`.

Current-schema additive fields are tolerated. Malformed JSON, a wrong
discriminator, an invalid identity, a noncanonical stage list, or a future
schema fails closed. Do not hand-edit a damaged record. Preserve it for
diagnosis, move it out of the coordinate-stable path, and rerun from the exact
recorded source revision; the new run will recompute local bytes and reverify
both registry coordinates before acquiring publication authority.

## Failure and recovery

| Observed state or failure                                           | Safe outcome and recovery                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Missing executable or provenance                                    | Stop before registry reads; rebuild, review, and commit the intended sidecar                                               |
| Stale hash, wrong PE machine, or changed build input                | Stop before registry reads; do not authorize bytes from file presence                                                      |
| One target build fails or promotion is interrupted                  | No complete new build is authorized; rebuild both and rerun verification                                                   |
| Dirty checkout before preflight                                     | Stop before tests and registry reads; commit, remove, or intentionally ignore/restore every tracked or untracked path      |
| Missing, insecure, credential-bearing, or malformed registry URL    | Stop before tests and registry reads; configure one canonical credential-free HTTPS npm registry                           |
| Git revision or any tracked/untracked path changes during preflight | Stop before the state record and registry reads; remove the concurrent editor and rerun from one completely clean revision |
| Test, lint, build, API, sidecar pack, or main pack fails            | No registry mutation has occurred; fix the local failure and rerun                                                         |
| Initial state publication fails                                     | No registry read or mutation has occurred; repair local filesystem durability/permissions and rerun                        |
| State contains only `local-preflight-complete`                      | Registry is freshly reconciled; absent packages publish in sidecar-then-main order                                         |
| Sidecar is exact, main is absent                                    | Record sidecar verification if needed, then publish and verify the main package                                            |
| Main is exact, sidecar is absent                                    | Verify the main tarball pins the intended sidecar, then publish and verify only the sidecar                                |
| Both packages are exact, state is stale or absent                   | Record both observed facts and finish without publication                                                                  |
| Sidecar publishes but its state write fails                         | Stop before main; retry observes the exact sidecar and continues                                                           |
| Main publishes but its state write fails                            | Retry observes both exact registry identities and records completion                                                       |
| Publish reports failure but an identical winner is visible          | Accept the registry fact after downloading and hashing it; continue                                                        |
| Publish and its immediate registry reconciliation both fail         | Report both causal failures; rerun the coordinator to establish registry truth before another publication decision         |
| Publish returns success but identity is not yet visible             | Stop after bounded visibility retries; rerun the coordinator rather than publishing blindly                                |
| Registry query times out, is unauthorized, or is malformed          | Stop; ambiguity is not converted to absence                                                                                |
| Published tarball disagrees with `dist` metadata                    | Stop; treat the download or registry metadata as corrupt                                                                   |
| Existing coordinate lacks provenance or has different bytes         | Stop; npm versions are immutable, so bump the changed package version                                                      |
| State records different source or bytes under the same versions     | Stop before registry reads; resume the recorded revision, or bump the changed package version                              |
| Configured registry differs from the recorded release registry      | Stop before registry reads; restore the intended registry or begin new package versions for the other registry             |
| Malformed or future local state                                     | Preserve and move the artifact for diagnosis; rerun from the recorded revision so local and registry facts are rebuilt     |
| Release lock is held by a live owner                                | Wait; a dead attributable owner is reclaimed conservatively, while unverifiable ownership fails closed                     |
| Cleanup and an earlier operation both fail                          | Both failures are reported; inspect registry/state first, then rerun to reconcile                                          |
| Lock ownership changes before release                               | Command exits nonzero; do not infer failure or success from the local message—rerun and require exact registry identity    |

Build outputs are produced in a private temporary directory. Only after both
targets and the manifest exist are individual files atomically replaced in the
sidecar directory. A process crash between replacements can leave an old/new
mixture visible, but the next verifier detects the mismatch and fails closed.

## Compatibility

Schema version 1 is the first executable provenance format. Readers accept
unknown additive fields within version 1 but require every identity and binary
field used by the release decision. Missing, malformed, older, or future
versions are not treated as legacy success. Changing a required field or its
meaning requires a new schema version and an explicit overlap policy before a
writer ships it.

The local release-state schema is independently versioned at 1. Because it has
not shipped before `0.19.6`, it has no legacy reader. Additive current fields
are compatible; removing or reinterpreting a required identity, source, stage,
or timestamp field requires a new schema and an explicit recovery policy.
