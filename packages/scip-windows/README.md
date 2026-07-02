# scip.exe release assets

These binaries are built from https://github.com/scip-code/scip.git at v0.8.1.
They are NOT bundled into the npm package. Upload each as a GitHub release
asset (scip-win32-<arch>.exe) and pin url + sha256 in
src/runtime/scip-windows-assets.ts before publishing — scip-query downloads
and checksum-verifies them on demand so Windows `reindex` works without
requiring Go or WSL.

Run `npm run build:scip-windows` to (re)build these before publishing.
