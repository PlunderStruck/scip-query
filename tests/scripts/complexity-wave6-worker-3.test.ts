import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// @ts-expect-error native script module has no shipped declarations
import { profileScoreboard } from '../../scripts/profile-scoreboard.mjs';
// @ts-expect-error native script module has no shipped declarations
import { inspectPortableExecutable } from '../../scripts/scip-windows-provenance.mjs';
import { extractImplementationBody } from '../../src/queries/cleanup/duplicate-bodies.js';

function deadPacketRenderer() {
  const path = 'scripts/accuracy-calibration.mjs';
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['renderDeadPacket', 'appendDeadRepository', 'appendDeadRow', 'escapeTable'];
  const selected = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(selected).toHaveLength(names.length);
  const context = createContext({});
  // Evaluate declarations only; calibration startup and external trials never run.
  runInContext(selected.map((node) => node.getText(source)).join('\n'), context);
  return context.renderDeadPacket as (packet: unknown) => string;
}

describe('wave6 worker3 behavior contracts', () => {
  it('keeps dead packet defaults, inventory escaping, zero-based conversion and trailing newlines', () => {
    const render = deadPacketRenderer();
    expect(
      render({
        language: 'rust',
        generatedAt: 'now',
        schemaVersion: 1,
        seed: 'seed',
        truthRule: 'review usage',
        summary: {},
        repositories: [{ repository: 'repo', error: 'bad|line\nnext' }],
        rows: [
          {
            repository: 'repo',
            shortName: 'call',
            calibrationId: 'id',
            commit: 'abc',
            relativePath: 'lib.rs',
            startLine: 0,
            endLine: 2,
            evidence: 'graph',
          },
        ],
      }),
    ).toBe(`# Rust Dead-Code Calibration Packet

Generated: now
Schema: 1
Seed: \`seed\`

Truth rule:

> review usage

## Repository Inventory

| Repository | Commit | Candidates | Sampled | Rust semantic | Error |
| --- | --- | ---: | ---: | --- | --- |
| repo | - | - | - | - | bad\\|line next |

## Current Summary

\`\`\`json
{}
\`\`\`

## 1. repo: call

- Calibration ID: \`id\`
- Commit: \`abc\`
- Location: \`lib.rs:1-3\`
- Evidence: graph
- Implicit usage: -
- Verdict: **PENDING**
- Noise archetype: -
- Evidence note: -

\`\`\`\`text
(source unavailable)
\`\`\`\`

`);
  });

  it('retains PE validation precedence when several headers are malformed', () => {
    const bytes = Buffer.alloc(128);
    expect(() => inspectPortableExecutable(bytes, 'fixture')).toThrow('missing the DOS MZ signature');
    bytes.write('MZ');
    expect(() => inspectPortableExecutable(bytes, 'fixture')).toThrow('invalid PE header offset');
    bytes.writeUInt32LE(64, 0x3c);
    expect(() => inspectPortableExecutable(bytes, 'fixture')).toThrow('missing the PE signature');
    bytes.write('PE\0\0', 64);
    expect(() => inspectPortableExecutable(bytes, 'fixture')).toThrow('unsupported PE machine');
    bytes.writeUInt16LE(0x8664, 68);
    expect(() => inspectPortableExecutable(bytes, 'fixture')).toThrow('not a PE32+ executable');
    bytes.writeUInt16LE(0x20b, 88);
    expect(inspectPortableExecutable(bytes, 'fixture')).toEqual({ peMachine: 'AMD64', peMachineCode: '0x8664' });
  });

  it('ignores nonfinite durations and metadata while retaining zero values, fallback names and tie ordering', () => {
    const rows = profileScoreboard([
      { phase: 'z', durationMs: Infinity, files: 9 },
      { phase: 'z', durationMs: 0, files: 0, pid: 50, stringNumber: '4' },
      { name: 'a', durationMs: 0, files: NaN },
      { phase: 'z', durationMs: 0, files: 2, bytes: -1 },
    ]);
    expect(rows).toEqual([
      { command: 'unknown', spanName: 'a', cacheState: 'unknown', totalDurationMs: 0, count: 1, numericMetadata: {} },
      {
        command: 'unknown',
        spanName: 'z',
        cacheState: 'unknown',
        totalDurationMs: 0,
        count: 2,
        numericMetadata: { files: 2, bytes: -1 },
      },
    ]);
  });

  it('keeps body scanning fallbacks for unmatched delimiters and nested type literals', () => {
    for (const [source, expected] of [
      ['f(x: { value: number }): Promise<{ ok: boolean }> { return x; }', ' return x; '],
      ['(x) => x + 1;;;  ', 'x + 1'],
      ['(x) => {', '{'],
      ['f(x: { value: number }', 'f(x: { value: number }'],
      [') => value;', 'value'],
      ['f() {}', ''],
    ])
      expect(extractImplementationBody(source!)).toBe(expected);
  });
});
