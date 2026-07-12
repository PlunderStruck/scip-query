import { describe, expect, it, vi } from 'vitest';
import {
  astParserLanguages,
  astParserPackagesForLanguages,
  setupAstParsers,
} from '../../src/runtime/ast-parser-setup.js';

describe('AST parser setup', () => {
  it('maps only supported languages and deduplicates pinned packages', () => {
    expect(astParserLanguages(['typescript', 'go', 'python', 'typescript', 'clojure'])).toEqual([
      'python',
      'typescript',
    ]);
    expect(
      astParserPackagesForLanguages(['typescript', 'python'], {
        'tree-sitter': '0.21.1',
        'tree-sitter-typescript': '0.23.2',
        'tree-sitter-python': '0.23.4',
      }),
    ).toEqual(['tree-sitter@0.21.1', 'tree-sitter-python@0.23.4', 'tree-sitter-typescript@0.23.2']);
  });

  it('installs missing parsers into the scip-query package root and re-probes', () => {
    let installed = false;
    const install = vi.fn(() => {
      installed = true;
      return { ok: true };
    });
    const result = setupAstParsers(['typescript'], {
      packageRoot: process.cwd(),
      runtime: {
        probe: () => installed,
        install,
        resetProbe: vi.fn(),
      },
    });

    expect(install).toHaveBeenCalledWith(process.cwd(), ['tree-sitter@0.21.1', 'tree-sitter-typescript@0.23.2']);
    expect(result).toMatchObject({
      attempted: true,
      availableBefore: [],
      availableAfter: ['typescript'],
      unavailable: [],
    });
  });

  it('does not invoke npm when every selected parser is already available', () => {
    const install = vi.fn(() => ({ ok: true }));
    const result = setupAstParsers(['rust'], {
      packageRoot: process.cwd(),
      runtime: { probe: () => true, install, resetProbe: vi.fn() },
    });
    expect(result.attempted).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it('reports native installation failures without claiming availability', () => {
    const result = setupAstParsers(['python'], {
      packageRoot: process.cwd(),
      runtime: {
        probe: () => false,
        install: () => ({ ok: false, error: 'native build failed' }),
        resetProbe: vi.fn(),
      },
    });
    expect(result).toMatchObject({
      attempted: true,
      installed: [],
      availableAfter: [],
      unavailable: ['python'],
      error: 'native build failed',
    });
  });
});
