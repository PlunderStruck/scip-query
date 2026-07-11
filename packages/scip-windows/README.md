# Windows scip.exe npm sidecar

These binaries are built from https://github.com/scip-code/scip.git at v0.8.1.
They are bundled in the OS-gated `scip-query-scip-windows` npm package. The main
`scip-query` package declares that sidecar as an optional dependency, so npm
installs it automatically on Windows and `reindex` works without Go or WSL.

Run `npm run build:scip-windows` to rebuild the binaries. Publishing the main
package verifies the version pin, builds missing binaries, and publishes the
matching sidecar first.
