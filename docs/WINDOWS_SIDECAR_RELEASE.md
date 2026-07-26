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

## Failure and recovery

| Failure                                                   | Result                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| Missing executable or manifest                            | Build, pack, and prepublish stop before registry work                 |
| Existing executable with stale size or SHA-256            | Stop; rebuild and review rather than trusting presence                |
| x64 filename containing ARM64 bytes, or the reverse       | Stop with the observed PE machine mismatch                            |
| Changed package version, source, tag, toolchain, or flags | Stop until the manifest and exact bytes are intentionally regenerated |
| One target build fails after the other succeeds           | No sidecar artifact is promoted from private staging                  |
| Promotion is interrupted                                  | A later verification rejects the mixed set; no release is authorized  |
| Future or malformed manifest schema                       | Stop with an explicit compatibility error                             |

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
