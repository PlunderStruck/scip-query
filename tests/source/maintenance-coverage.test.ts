import { describe, expect, it } from 'vitest';
import { analyzeSourceFunctions, sourceHash } from '../../src/source/ast/function-metrics.js';
import { functionCoverage, type ReviewCoverage } from '../../src/source/maintenance-coverage.js';

const source = 'function choose(flag: boolean) {\n  if (flag) return 1;\n  return 0;\n}';
const functions = analyzeSourceFunctions('choose.ts', source).functions;
const span = { start: { line: 2, column: 2 } };
const measure = (coverage: unknown) =>
  functionCoverage(functions[0]!, functions, source, {
    files: { 'choose.ts': { sourceHash: sourceHash(source), coverage } },
  } as ReviewCoverage);

describe('source-matched statement coverage', () => {
  it.each([
    { statementMap: [span], s: { 0: 1 } },
    { statementMap: { 0: span }, s: [1] },
  ])('rejects arrays in place of coverage maps: %j', (coverage) => {
    expect(measure(coverage)).toEqual({ status: 'unavailable', reason: 'Malformed statement coverage.' });
  });

  it('combines measured statements on one line without counting that line twice', () => {
    expect(
      measure({
        statementMap: { a: span, b: { start: { line: 2, column: 12 } }, c: { start: { line: 3, column: 2 } } },
        s: { a: 0, b: 1, c: 0 },
      }),
    ).toMatchObject({ status: 'available', measuredLines: 2, coveredLines: 1, fraction: 0.5, crap: 2.5 });
  });

  it('rejects malformed locations even outside the selected function', () => {
    expect(
      measure({ statementMap: { a: span, b: { start: { line: 100, column: 0 } } }, s: { a: 1, b: 1 } }),
    ).toMatchObject({ status: 'unavailable', reason: 'Malformed statement coverage locations or counts.' });
  });
});
