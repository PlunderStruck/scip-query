import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveRustLibrarySurface,
  isExternallyPublicRustDeclaration,
  isRustLibrarySourceFile,
} from '../../src/analysis/rust-package-surface.js';

let tempRoot: string | undefined;

function write(relativePath: string, contents = ''): void {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'scip-rust-surface-'));
  const path = join(tempRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe('deriveRustLibrarySurface', () => {
  it('distinguishes library sources from binary-only targets', () => {
    write('Cargo.toml', '[package]\nname = "fixture"\nversion = "0.1.0"\n');
    write('src/lib.rs', 'pub mod api;\n');
    write('src/api.rs', 'pub fn public_api() {}\n');
    write('src/main.rs', 'pub fn binary_only() {}\n');
    write('src/bin/helper.rs', 'pub fn helper_binary_only() {}\n');

    const surface = deriveRustLibrarySurface(tempRoot!);
    expect(isRustLibrarySourceFile(surface, 'src/lib.rs')).toBe(true);
    expect(isRustLibrarySourceFile(surface, 'src/api.rs')).toBe(true);
    expect(isRustLibrarySourceFile(surface, 'src/main.rs')).toBe(false);
    expect(isRustLibrarySourceFile(surface, 'src/bin/helper.rs')).toBe(false);
  });

  it('finds nested and custom-path library targets while honoring autolib false', () => {
    write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
    write(
      'crates/custom/Cargo.toml',
      '[package]\nname = "custom"\nversion = "0.1.0"\n[lib]\npath = "source/root.rs"\n',
    );
    write('crates/custom/source/root.rs', 'pub mod api;\n');
    write('crates/custom/source/api.rs', 'pub fn api() {}\n');
    write('crates/binary/Cargo.toml', '[package]\nname = "binary"\nversion = "0.1.0"\nautolib = false\n');
    write('crates/binary/src/lib.rs', 'pub fn not_a_library() {}\n');

    const surface = deriveRustLibrarySurface(tempRoot!);
    expect(surface.rootFiles.has('crates/custom/source/root.rs')).toBe(true);
    expect(isRustLibrarySourceFile(surface, 'crates/custom/source/api.rs')).toBe(true);
    expect(isRustLibrarySourceFile(surface, 'crates/binary/src/lib.rs')).toBe(false);
  });
});

describe('isExternallyPublicRustDeclaration', () => {
  it('accepts public declarations but not restricted or private visibility', () => {
    expect(isExternallyPublicRustDeclaration('pub async fn run() {}')).toBe(true);
    expect(isExternallyPublicRustDeclaration('    pub const LIMIT: usize = 1;')).toBe(true);
    expect(isExternallyPublicRustDeclaration('pub(crate) fn internal() {}')).toBe(false);
    expect(isExternallyPublicRustDeclaration('fn private() {}')).toBe(false);
  });
});
