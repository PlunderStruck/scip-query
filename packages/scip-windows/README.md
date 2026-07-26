# Windows scip.exe npm sidecar

These binaries are built from https://github.com/scip-code/scip.git at v0.8.1
(bf70486060b71bed40f3d6dd19c96da4b3239ead) with go1.26.4.
They are bundled in the OS-gated `scip-query-scip-windows` npm package. The main
`scip-query` package declares that sidecar as an optional dependency, so npm
installs it automatically on Windows and `reindex` works without Go or WSL.

`provenance.json` binds the package version and exact source,
toolchain, build flags, target machine, file size, and SHA-256 for both binaries.
Build, pack, and publish checks reject missing or mismatched evidence.

Run `npm run build:scip-windows` to rebuild the binaries and provenance manifest.
Review and commit the manifest change before release. Publishing the main package
verifies the version pin and the complete sidecar provenance before any registry
decision.
