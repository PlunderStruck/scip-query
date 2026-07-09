import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  dedupeSemanticReferences,
  definitionToReferenceParams,
  documentUriToRelativePath,
  filePathToDocumentUri,
  locationsToSemanticReferences,
  referencePositionFromSource,
} from '../../../src/semantic/rust/reference-mapping.js';
import { cargoManifestsForDefinitions, rustAnalyzerSessionRoot } from '../../../src/semantic/rust/lsp-batch-worker.js';

function rustDefinition(overrides: Partial<IndexedDefinition> = {}): IndexedDefinition {
  return {
    symbolId: 7,
    symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/compute_total().',
    documentId: 1,
    startLine: 1,
    startChar: 0,
    endLine: 3,
    endChar: 1,
    relativePath: 'src/lib.rs',
    leaf: 'compute_total',
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 12,
    documentation: null,
    enclosingSymbol: null,
    ...overrides,
  };
}

describe('Rust reference mapping', () => {
  it('round-trips file URIs with spaces to repository-relative paths', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-uri-'));
    try {
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      const uri = filePathToDocumentUri(projectRoot, 'src/main lib.rs');

      expect(uri).toMatch(/^file:\/\//);
      expect(uri).toContain('main%20lib.rs');
      expect(documentUriToRelativePath(projectRoot, uri)).toBe('src/main lib.rs');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('builds reference params at the Rust leaf name without shifting zero-based lines', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-position-'));
    try {
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(
        join(projectRoot, 'src/lib.rs'),
        ['pub mod math {', '    pub fn compute_total(value: i32) -> i32 {', '        value + 1', '    }', '}'].join(
          '\n',
        ),
      );

      const params = definitionToReferenceParams(projectRoot, rustDefinition(), false);

      expect(params.textDocument.uri).toBe(filePathToDocumentUri(projectRoot, 'src/lib.rs'));
      expect(params.position).toEqual({ line: 1, character: 22 });
      expect(params.context).toEqual({ includeDeclaration: false });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('recovers the Rust leaf position from a nearby line when source-backed rows are editor-indexed', () => {
    const source = ['pub fn run() {', '    compute_total();', '}'].join('\n');

    expect(referencePositionFromSource(source, rustDefinition({ startLine: 1, leaf: 'run' }))).toEqual({
      line: 0,
      character: 8,
    });
  });

  it('converts LSP locations to sorted semantic references and removes duplicates', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-locations-'));
    try {
      const references = locationsToSemanticReferences(projectRoot, [
        {
          uri: filePathToDocumentUri(projectRoot, 'src/consumer.rs'),
          range: { start: { line: 8, character: 14 }, end: { line: 8, character: 27 } },
        },
        {
          uri: filePathToDocumentUri(projectRoot, 'src/lib.rs'),
          range: { start: { line: 1, character: 11 }, end: { line: 1, character: 24 } },
        },
        {
          uri: filePathToDocumentUri(projectRoot, 'src/consumer.rs'),
          range: { start: { line: 8, character: 14 }, end: { line: 8, character: 27 } },
        },
      ]);

      expect(dedupeSemanticReferences(references)).toEqual([
        { file: 'src/consumer.rs', line: 8, column: 14 },
        { file: 'src/lib.rs', line: 1, column: 11 },
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('discovers the nearest Cargo manifest for nested Rust crates', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-cargo-root-'));
    try {
      mkdirSync(join(projectRoot, 'src-tauri/src'), { recursive: true });
      writeFileSync(join(projectRoot, 'src-tauri/Cargo.toml'), '[package]\nname = "fixture"\n');

      expect(
        cargoManifestsForDefinitions(projectRoot, [rustDefinition({ relativePath: 'src-tauri/src/lib.rs' })]),
      ).toEqual([join(projectRoot, 'src-tauri/Cargo.toml')]);
      expect(rustAnalyzerSessionRoot(projectRoot, [join(projectRoot, 'src-tauri/Cargo.toml')])).toBe(
        join(projectRoot, 'src-tauri'),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
