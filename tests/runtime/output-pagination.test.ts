import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLI_OUTPUT_PAGE_KIND,
  CLI_OUTPUT_PAGE_SCHEMA_VERSION,
  DEFAULT_OUTPUT_PAGE_SIZE,
  MAX_OUTPUT_CURSOR_LENGTH,
  MAX_OUTPUT_PAGE_SIZE,
  MIN_OUTPUT_PAGE_SIZE,
  continueCliOutput,
  decodeCliOutputPageEnvelope,
  inspectPendingCliOutputCursor,
  parseOutputPageSize,
  requireCliOutputPageEnvelope,
  runWithCliOutputPagination,
  type CliOutputPageEnvelopeV1,
  type CliOutputPaginationOptions,
} from '../../src/runtime/output-pagination.js';
import { bindSourceEmissionGeneration, renderSourceEvidence } from '../../src/runtime/source-emission-session.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function invoke(
  content: string | readonly Uint8Array[] | (() => void),
  overrides: Partial<CliOutputPaginationOptions> = {},
): Promise<{ stdout: string; stderr: string }> {
  const directStdout: Buffer[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    directStdout.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  });
  const renderedStdout: string[] = [];
  const stderr: string[] = [];
  await runWithCliOutputPagination(
    {
      command: 'demo',
      producerVersion: 'test',
      argv: ['demo'],
      cwd: '/repo',
      json: false,
      ...overrides,
    },
    () => {
      if (typeof content === 'function') {
        content();
      } else if (typeof content === 'string') {
        process.stdout.write(content);
      } else {
        for (const chunk of content) process.stdout.write(chunk);
      }
    },
    {
      writeStdout: (value) => renderedStdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
  );
  return {
    stdout: Buffer.concat([...directStdout, ...renderedStdout.map((value) => Buffer.from(value))]).toString('utf8'),
    stderr: stderr.join(''),
  };
}

function parsePage(output: string): CliOutputPageEnvelopeV1 {
  return requireCliOutputPageEnvelope(JSON.parse(output));
}

function parseHumanPage(output: string): { content: string; cursor?: string } {
  const contentStart = output.indexOf('\n') + 1;
  const incompleteStart = output.lastIndexOf('\n[Incomplete:');
  const completeStart = output.lastIndexOf('\n[scip-query transport complete; evaluate command coverage separately]');
  const contentEnd = Math.max(incompleteStart, completeStart);
  if (contentStart <= 0 || contentEnd < contentStart) throw new Error('Expected a rendered human output page.');
  const cursor = output.match(/\bcontinue ([A-Za-z0-9_.-]+)/u)?.[1];
  return {
    content: output.slice(contentStart, contentEnd),
    ...(cursor ? { cursor } : {}),
  };
}

async function continueOutput(cursor: string, snapshotRoot: string): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await continueCliOutput(cursor, 'test', snapshotRoot, {
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  });
  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

function freshSnapshotRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'scip-query-output-pagination-test-'));
  tempDirs.push(path);
  return path;
}

describe('universal CLI output pagination', () => {
  it('rejects contradictory page completion states at the decoder boundary', () => {
    const common = {
      kind: CLI_OUTPUT_PAGE_KIND,
      schemaVersion: CLI_OUTPUT_PAGE_SCHEMA_VERSION,
      producer: { name: 'scip-query', version: 'test' },
      command: 'refs',
      contentType: 'application/json',
      content: 'abc',
    } as const;
    const page = {
      offset: 0,
      returnedCharacters: 3,
      totalCharacters: 6,
      omittedCharacters: 3,
      remainingCharacters: 3,
      outputHash: 'a'.repeat(64),
    };

    expect(decodeCliOutputPageEnvelope({ ...common, page: { ...page, complete: false } })).toMatchObject({
      kind: 'malformed',
      reason: expect.stringContaining('requires a non-empty continuation'),
    });
    expect(
      decodeCliOutputPageEnvelope({
        ...common,
        page: {
          ...page,
          totalCharacters: 3,
          omittedCharacters: 0,
          remainingCharacters: 0,
          complete: true,
          continuation: { cursor: 'next', command: 'scip-query refs x' },
        },
      }),
    ).toMatchObject({
      kind: 'malformed',
      reason: expect.stringContaining('cannot have remaining content or a continuation'),
    });
  });

  it('retrieves every character across stable pages with exact continuation commands', async () => {
    const content = Array.from({ length: 730 }, (_, index) => String(index % 10)).join('');
    const argv = ['demo', "O'Reilly", '--json'];
    const invocationPrefix = ['npx', 'scip-query'];
    const root = freshSnapshotRoot();
    const pages: CliOutputPageEnvelopeV1[] = [];
    let cursor: string | undefined;

    do {
      const result = cursor
        ? await continueOutput(cursor, root)
        : await invoke(content, {
            argv: [...argv, '--output-page-size', '256'],
            invocationPrefix,
            json: true,
            pageSize: 256,
            snapshotRoot: root,
          });
      const page = parsePage(result.stdout);
      pages.push(page);
      cursor = page.page.continuation?.cursor;
    } while (cursor);

    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.content).join('')).toBe(content);
    expect(pages[0]).toMatchObject({
      kind: CLI_OUTPUT_PAGE_KIND,
      schemaVersion: 1,
      command: 'demo',
      contentType: 'application/json',
      agentInstruction: expect.stringContaining('do not draw conclusions'),
      page: {
        offset: 0,
        returnedCharacters: 256,
        totalCharacters: 730,
        remainingCharacters: 474,
        complete: false,
      },
    });
    expect(pages[0]!.page.continuation?.command).toBe(`npx scip-query continue ${pages[0]!.page.continuation!.cursor}`);
    expect(pages[2]!.page).toMatchObject({
      offset: 512,
      returnedCharacters: 218,
      remainingCharacters: 0,
      complete: true,
    });
    expect(pages[2]!.agentInstruction).toContain('OUTPUT COMPLETE');
  });

  it('preserves one original evidence context across every JSON output page', async () => {
    const envelope = {
      kind: 'scip-query-result',
      schemaVersion: 1,
      producer: { name: 'scip-query', version: 'test' },
      command: 'stats',
      resultSchemaVersion: 1,
      args: [],
      options: { json: true },
      result: { rows: ['x'.repeat(700)] },
      evidenceContext: {
        schemaVersion: 1,
        receipt: {
          schemaVersion: 1,
          authorityKind: 'index-only',
          observedAt: '2026-07-30T12:00:00.000Z',
          projectIdentity: 'project',
          index: {
            generationIdentity: 'generation',
            source: 'immutable',
            alignment: 'not-certified',
          },
        },
        analysisManifest: { schemaVersion: 1, evidence: 'graph-fact' },
      },
    };
    const content = `${JSON.stringify(envelope)}\n`;
    const root = freshSnapshotRoot();
    const pages: CliOutputPageEnvelopeV1[] = [];
    let cursor: string | undefined;

    do {
      const result = await invoke(content, {
        argv: ['stats', '--json', '--output-page-size', '256', ...(cursor ? ['--output-cursor', cursor] : [])],
        command: 'stats',
        json: true,
        pageSize: 256,
        snapshotRoot: root,
        ...(cursor ? { cursor } : {}),
      });
      const page = parsePage(result.stdout);
      pages.push(page);
      cursor = page.page.continuation?.cursor;
    } while (cursor);

    expect(JSON.parse(pages.map((page) => page.content).join(''))).toEqual(envelope);
    expect(pages.map((page) => page.page.outputHash)).toEqual(
      Array.from({ length: pages.length }, () => pages[0]!.page.outputHash),
    );
  });

  it('automatically pages oversized human output as readable text with one exact continuation', async () => {
    const content = `${'a'.repeat(DEFAULT_OUTPUT_PAGE_SIZE)}TAIL`;
    const result = await invoke(content, {
      argv: ['demo', 'target with spaces'],
      invocationPrefix: ['/usr/local/bin/node', '/repo with spaces/dist/cli.js'],
    });

    expect(result.stdout.startsWith('[scip-query output page:')).toBe(true);
    expect(result.stdout).toContain(`characters 0-${DEFAULT_OUTPUT_PAGE_SIZE - 1} of ${content.length}`);
    expect(result.stdout).toContain('a'.repeat(100));
    expect(result.stdout).not.toContain('TAIL');
    expect(result.stdout.match(/Continue exactly:/gu)).toHaveLength(1);
    expect(result.stdout).not.toContain('"content":');
    expect(result.stdout).not.toContain('"kind":');
    expect(result.stdout).toContain(`/usr/local/bin/node '/repo with spaces/dist/cli.js' continue `);
  });

  it('keeps human page boundaries aligned to complete lines when a newline fits the page', async () => {
    const content = Array.from(
      { length: 20 },
      (_, index) => `${String(index + 1).padStart(4)}  ${`line-${index + 1}`.padEnd(54, '.')}\n`,
    ).join('');
    const root = freshSnapshotRoot();
    const pages: string[] = [];
    const outputs: string[] = [];
    let cursor: string | undefined;

    do {
      const result = await invoke(content, {
        argv: ['demo', '--output-page-size', '256', ...(cursor ? ['--output-cursor', cursor] : [])],
        pageSize: 256,
        snapshotRoot: root,
        ...(cursor ? { cursor } : {}),
      });
      outputs.push(result.stdout);
      const page = parseHumanPage(result.stdout);
      pages.push(page.content);
      cursor = page.cursor;
    } while (cursor);

    expect(pages.join('')).toBe(content);
    expect(pages.slice(0, -1).every((page) => page.endsWith('\n'))).toBe(true);
    expect(pages.slice(1).every((page) => /^\s*\d+\s{2}line-/u.test(page))).toBe(true);
    expect(outputs.at(-1)).toContain('[scip-query transport complete; evaluate command coverage separately]');
  });

  it('keeps unpaged JSON byte-compatible and warns before oversized output with an exact paging command', async () => {
    const payload = `${JSON.stringify({ rows: ['x'.repeat(DEFAULT_OUTPUT_PAGE_SIZE)] })}\n`;
    const result = await invoke(payload, {
      argv: ['demo', '--json', '--compact'],
      invocationPrefix: ['pnpm', 'exec', 'scip-query'],
      json: true,
    });

    expect(result.stdout).toBe(payload);
    expect(result.stderr).toContain(`JSON output exceeds ${DEFAULT_OUTPUT_PAGE_SIZE} characters`);
    expect(result.stderr).toContain('Do not use possibly partial client output as evidence');
    expect(result.stderr).toContain(
      `Read every page with: pnpm exec scip-query demo --json --compact --output-page-size ${DEFAULT_OUTPUT_PAGE_SIZE}`,
    );
    expect(result.stderr.match(/Read every page with:/gu)).toHaveLength(2);
  });

  it('preserves raw JSON bytes when a multi-byte character is split across writes', async () => {
    const payload = `${JSON.stringify({ value: `${'x'.repeat(DEFAULT_OUTPUT_PAGE_SIZE)}π` })}\n`;
    const bytes = Buffer.from(payload);
    const split = bytes.indexOf(Buffer.from('π')) + 1;
    const result = await invoke([bytes.subarray(0, split), bytes.subarray(split)], {
      argv: ['demo', '--json'],
      json: true,
    });

    expect(result.stdout).toBe(payload);
    expect(JSON.parse(result.stdout)).toEqual({ value: `${'x'.repeat(DEFAULT_OUTPUT_PAGE_SIZE)}π` });
    expect(result.stderr.match(/Read every page with:/gu)).toHaveLength(2);
  });

  it('keeps small human and JSON output unchanged', async () => {
    await expect(invoke('human\n')).resolves.toEqual({ stdout: 'human\n', stderr: '' });
    await expect(invoke('{"ok":true}\n', { argv: ['demo', '--json'], json: true })).resolves.toEqual({
      stdout: '{"ok":true}\n',
      stderr: '',
    });
  });

  it('keeps explicitly bounded JSON raw when it fits in one page', async () => {
    const root = freshSnapshotRoot();
    const result = await invoke('small\n', {
      argv: ['demo', '--json', '--output-page-size', '256'],
      json: true,
      pageSize: 256,
      snapshotRoot: root,
    });

    expect(result).toEqual({ stdout: 'small\n', stderr: '' });
    expect(readdirSync(root)).toEqual([]);
  });

  it('keeps explicitly bounded human output raw when it fits in one page', async () => {
    const result = await invoke('first line\nsecond line\n', {
      argv: ['demo', '--output-page-size', '256'],
      pageSize: 256,
    });

    expect(result.stdout).toBe('first line\nsecond line\n');
    expect(result.stdout).not.toContain('"content":');
    expect(result.stdout).not.toContain('"page":');
  });

  it('commits session source only after complete output reaches the transport runtime', async () => {
    const sessionRoot = freshSnapshotRoot();
    const priorSession = process.env['SCIP_QUERY_SESSION'];
    const priorSessionRoot = process.env['SCIP_QUERY_SESSION_DIR'];
    process.env['SCIP_QUERY_SESSION'] = `pagination-${randomUUID()}`;
    process.env['SCIP_QUERY_SESSION_DIR'] = sessionRoot;
    const renderSource = () => {
      bindSourceEmissionGeneration('pagination-generation');
      process.stdout.write(
        renderSourceEvidence({
          relativePath: 'src/demo.ts',
          startLine: 4,
          source: 'const delivered = true;',
          sessionPolicy: 'preview',
        }),
      );
    };
    try {
      const first = await invoke(renderSource);
      const second = await invoke(renderSource);
      expect(first.stdout).toContain('5  const delivered = true;');
      expect(second.stdout).toContain(
        'src/demo.ts:5-5  [source previously emitted: session #1 via demo; not repeated]',
      );
      expect(second.stdout).not.toContain('const delivered = true;');
    } finally {
      restoreEnvironment('SCIP_QUERY_SESSION', priorSession);
      restoreEnvironment('SCIP_QUERY_SESSION_DIR', priorSessionRoot);
    }
  });

  it('emits short snapshot locators and accepts legacy version-3 cursors', async () => {
    const root = freshSnapshotRoot();
    const first = parsePage(
      (
        await invoke('x'.repeat(600), {
          argv: ['demo', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
          snapshotRoot: root,
        })
      ).stdout,
    );
    const cursor = first.page.continuation!.cursor;
    expect(cursor).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{11}$/u);
    expect(cursor).toHaveLength(12);

    const pending = inspectPendingCliOutputCursor(cursor, root);
    expect(pending).toBeDefined();
    const metadata = JSON.parse(readFileSync(join(root, `${pending!.snapshotId}.json`), 'utf8')) as {
      snapshotId: string;
      invocationHash: string;
      outputHash: string;
      pageSize: number;
    };
    const reservation = JSON.parse(readFileSync(join(root, `${pending!.snapshotId}.reserve`), 'utf8')) as {
      snapshotId: string;
    };
    const legacySnapshotId = randomUUID();
    for (const extension of ['json', 'output', 'reserve']) {
      renameSync(join(root, `${pending!.snapshotId}.${extension}`), join(root, `${legacySnapshotId}.${extension}`));
    }
    metadata.snapshotId = legacySnapshotId;
    reservation.snapshotId = legacySnapshotId;
    writeFileSync(join(root, `${legacySnapshotId}.json`), JSON.stringify(metadata));
    writeFileSync(join(root, `${legacySnapshotId}.reserve`), JSON.stringify(reservation));
    const legacyCursor = Buffer.from(
      JSON.stringify({
        version: 3,
        invocationHash: metadata.invocationHash,
        pageIndex: 1,
        pageSize: metadata.pageSize,
        outputHash: metadata.outputHash,
        snapshotId: legacySnapshotId,
      }),
      'utf8',
    ).toString('base64url');

    const second = parsePage(
      (
        await invoke('must not execute', {
          argv: ['demo', '--json', '--output-page-size', '256', '--output-cursor', legacyCursor],
          json: true,
          pageSize: 256,
          cursor: legacyCursor,
          snapshotRoot: root,
        })
      ).stdout,
    );
    expect(second.page.offset).toBe(256);
    expect(second.content).toBe('x'.repeat(256));
    expect(second.page.continuation!.cursor).toMatch(/^4\.[A-Za-z0-9_-]{22}\.2$/u);
  });

  it('preserves Unicode exactly across page boundaries and rejects page-size drift', async () => {
    const content = `${'a'.repeat(255)}😀${'β'.repeat(300)}`;
    const root = freshSnapshotRoot();
    const pages: CliOutputPageEnvelopeV1[] = [];
    let cursor: string | undefined;

    do {
      const result = await invoke(content, {
        argv: ['demo', '--json', '--output-page-size', '256', ...(cursor ? ['--output-cursor', cursor] : [])],
        json: true,
        pageSize: 256,
        snapshotRoot: root,
        ...(cursor ? { cursor } : {}),
      });
      const page = parsePage(result.stdout);
      pages.push(page);
      cursor = page.page.continuation?.cursor;
    } while (cursor);

    expect(pages.map((page) => page.content).join('')).toBe(content);
    expect(pages[0]!.content.endsWith('\ud83d')).toBe(false);
    expect(pages[1]!.content.startsWith('\ude00')).toBe(false);

    const first = parsePage(
      (
        await invoke('z'.repeat(700), {
          argv: ['demo', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
          snapshotRoot: root,
        })
      ).stdout,
    );
    await expect(
      invoke('ignored', {
        argv: ['demo', '--json', '--output-page-size', '300', '--output-cursor', first.page.continuation!.cursor],
        json: true,
        pageSize: 300,
        cursor: first.page.continuation!.cursor,
        snapshotRoot: root,
      }),
    ).rejects.toThrow(/page size changed.*use 256/u);
  });

  it('reads each immutable continuation page once and detects requested-page corruption', async () => {
    const content = Array.from({ length: 1_030 }, (_, index) => String(index % 10)).join('');
    const root = freshSnapshotRoot();
    const readSizes: number[] = [];
    const first = parsePage(
      (
        await invoke(content, {
          argv: ['demo', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
          snapshotRoot: root,
        })
      ).stdout,
    );
    let cursor = first.page.continuation?.cursor;
    const pages = [first.content];
    while (cursor) {
      const page = parsePage(
        (
          await invoke('must not execute', {
            argv: ['demo', '--json', '--output-page-size', '256', '--output-cursor', cursor],
            json: true,
            pageSize: 256,
            cursor,
            snapshotRoot: root,
            onSnapshotRead: (bytes) => readSizes.push(bytes),
          })
        ).stdout,
      );
      pages.push(page.content);
      cursor = page.page.continuation?.cursor;
    }
    expect(pages.join('')).toBe(content);
    expect(readSizes.reduce((total, bytes) => total + bytes, 0)).toBe(Buffer.byteLength(content) - 256);

    const corrupt = parsePage(
      (
        await invoke('q'.repeat(700), {
          argv: ['demo', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
          snapshotRoot: root,
        })
      ).stdout,
    );
    const corruptCursor = corrupt.page.continuation!.cursor;
    const corruptSnapshot = inspectPendingCliOutputCursor(corruptCursor, root);
    expect(corruptSnapshot).toBeDefined();
    const outputPath = join(root, `${corruptSnapshot!.snapshotId}.output`);
    const bytes = readFileSync(outputPath);
    bytes[256] = bytes[256] === 113 ? 114 : 113;
    writeFileSync(outputPath, bytes);
    await expect(
      invoke('ignored', {
        argv: ['demo', '--json', '--output-page-size', '256', '--output-cursor', corrupt.page.continuation!.cursor],
        json: true,
        pageSize: 256,
        cursor: corrupt.page.continuation!.cursor,
        snapshotRoot: root,
      }),
    ).rejects.toThrow(/page no longer matches/u);
  });

  it('continues from an immutable snapshot without rerunning a nondeterministic command', async () => {
    let executions = 0;
    const render = () => {
      executions += 1;
      process.stdout.write(`run:${executions}:${'a'.repeat(600)}`);
    };
    const first = parsePage(
      (
        await invoke(render, {
          argv: ['demo', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
        })
      ).stdout,
    );
    const cursor = first.page.continuation!.cursor;
    expect(inspectPendingCliOutputCursor(cursor)).toMatchObject({
      pageIndex: 1,
      command: 'demo',
      cwd: '/repo',
      continuationCommand: first.page.continuation!.command,
      remainingCharacters: 350,
      totalCharacters: 606,
    });
    const second = parsePage(
      (
        await invoke(render, {
          argv: ['demo', '--json', '--output-page-size', '256', '--output-cursor', cursor],
          json: true,
          pageSize: 256,
          cursor,
        })
      ).stdout,
    );
    const secondCursor = second.page.continuation!.cursor;
    const pendingSnapshot = inspectPendingCliOutputCursor(cursor);
    expect(pendingSnapshot).toBeDefined();
    const snapshotRoot = join(
      tmpdir(),
      `scip-query-output-pages-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
    );
    if (process.platform !== 'win32') {
      expect(statSync(snapshotRoot).mode & 0o777).toBe(0o700);
      expect(statSync(join(snapshotRoot, `${pendingSnapshot!.snapshotId}.output`)).mode & 0o777).toBe(0o600);
      expect(statSync(join(snapshotRoot, `${pendingSnapshot!.snapshotId}.json`)).mode & 0o777).toBe(0o600);
    }
    const third = parsePage(
      (
        await invoke(render, {
          argv: ['demo', '--json', '--output-page-size', '256', '--output-cursor', secondCursor],
          json: true,
          pageSize: 256,
          cursor: secondCursor,
        })
      ).stdout,
    );

    expect(executions).toBe(1);
    expect(`${first.content}${second.content}${third.content}`).toBe(`run:1:${'a'.repeat(600)}`);
    expect(third.page.complete).toBe(true);
    expect(inspectPendingCliOutputCursor(cursor)).toBeUndefined();
    expect(existsSync(join(snapshotRoot, `${pendingSnapshot!.snapshotId}.output`))).toBe(false);
    expect(existsSync(join(snapshotRoot, `${pendingSnapshot!.snapshotId}.json`))).toBe(false);
  });

  it('rejects invocation drift, missing snapshots, oversized cursors, and accumulated output overflow', async () => {
    const invocationPrefix = ['/usr/local/bin/node', '/repo/dist/cli.js'];
    const first = parsePage(
      (
        await invoke('a'.repeat(600), {
          argv: ['demo', '--json', '--output-page-size', '256'],
          invocationPrefix,
          json: true,
          pageSize: 256,
        })
      ).stdout,
    );
    const cursor = first.page.continuation!.cursor;

    await expect(
      invoke('a'.repeat(600), {
        argv: ['other', '--json', '--output-page-size', '256', '--output-cursor', cursor],
        invocationPrefix,
        json: true,
        pageSize: 256,
        cursor,
      }),
    ).rejects.toThrow(/different command, working directory, or argument set/u);

    await expect(
      invoke('a'.repeat(600), {
        argv: ['demo', '--json', '--output-page-size', '256', '--output-cursor', cursor],
        invocationPrefix: ['scip-query'],
        json: true,
        pageSize: 256,
        cursor,
      }),
    ).rejects.toThrow(/different command, working directory, or argument set/u);

    const pendingSnapshot = inspectPendingCliOutputCursor(cursor);
    expect(pendingSnapshot).toBeDefined();
    const snapshotRoot = join(
      tmpdir(),
      `scip-query-output-pages-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
    );
    rmSync(join(snapshotRoot, `${pendingSnapshot!.snapshotId}.json`), { force: true });
    rmSync(join(snapshotRoot, `${pendingSnapshot!.snapshotId}.output`), { force: true });
    await expect(
      invoke('a'.repeat(600), {
        argv: ['demo', '--json', '--output-page-size', '256', '--output-cursor', cursor],
        invocationPrefix,
        json: true,
        pageSize: 256,
        cursor,
      }),
    ).rejects.toThrow(
      /snapshot is unavailable.*Restart with: \/usr\/local\/bin\/node \/repo\/dist\/cli\.js demo --json --output-page-size 256/u,
    );

    await expect(invoke('x', { cursor: 'x'.repeat(MAX_OUTPUT_CURSOR_LENGTH + 1) })).rejects.toThrow(/cursor exceeds/u);
    await expect(
      invoke('x'.repeat(301), {
        argv: ['demo', '--output-page-size', '256'],
        pageSize: 256,
        maxOutputCharacters: 300,
      }),
    ).rejects.toThrow(/300-character safety limit/u);
  });

  it('enforces per-snapshot and aggregate byte quotas without leaking failed reservations', async () => {
    const exactRoot = freshSnapshotRoot();
    const exact = parsePage(
      (
        await invoke('x'.repeat(300), {
          argv: ['demo', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
          snapshotRoot: exactRoot,
          snapshotLimits: { maxSnapshotBytes: 300, maxAggregateBytes: 300, maxSnapshotCount: 1 },
        })
      ).stdout,
    );
    await expect(
      invoke('ignored', {
        argv: ['demo', '--json', '--output-page-size', '256', '--output-cursor', exact.page.continuation!.cursor],
        json: true,
        pageSize: 256,
        cursor: exact.page.continuation!.cursor,
        snapshotRoot: exactRoot,
        snapshotLimits: { maxSnapshotBytes: 300, maxAggregateBytes: 300, maxSnapshotCount: 1 },
      }),
    ).resolves.toBeDefined();
    expect(readdirSync(exactRoot).filter((entry) => /\.(?:json|output|tmp|reserve)$/u.test(entry))).toEqual([]);

    const overRoot = freshSnapshotRoot();
    await expect(
      invoke('x'.repeat(301), {
        argv: ['demo', '--json', '--output-page-size', '256'],
        json: true,
        pageSize: 256,
        snapshotRoot: overRoot,
        snapshotLimits: { maxSnapshotBytes: 300, maxAggregateBytes: 600, maxSnapshotCount: 2 },
      }),
    ).rejects.toThrow(/300-byte snapshot limit/u);
    expect(readdirSync(overRoot).filter((entry) => /\.(?:json|output|tmp|reserve)$/u.test(entry))).toEqual([]);

    const aggregateRoot = freshSnapshotRoot();
    const first = parsePage(
      (
        await invoke('a'.repeat(600), {
          argv: ['demo', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
          snapshotRoot: aggregateRoot,
          snapshotLimits: { maxSnapshotBytes: 700, maxAggregateBytes: 900, maxSnapshotCount: 4 },
        })
      ).stdout,
    );
    await expect(
      invoke('b'.repeat(400), {
        argv: ['other', '--json', '--output-page-size', '256'],
        json: true,
        pageSize: 256,
        snapshotRoot: aggregateRoot,
        snapshotLimits: { maxSnapshotBytes: 700, maxAggregateBytes: 900, maxSnapshotCount: 4 },
      }),
    ).rejects.toThrow(/snapshot capacity is full/u);
    const firstSnapshot = inspectPendingCliOutputCursor(first.page.continuation!.cursor, aggregateRoot);
    expect(firstSnapshot).toBeDefined();
    expect(existsSync(join(aggregateRoot, `${firstSnapshot!.snapshotId}.reserve`))).toBe(true);
    expect(readdirSync(aggregateRoot).filter((entry) => entry.endsWith('.reserve'))).toHaveLength(1);
  });

  it('reclaims an abandoned temporary snapshot but preserves a live active writer', async () => {
    const root = freshSnapshotRoot();
    const limits = { maxSnapshotBytes: 2_000, maxAggregateBytes: 5_000, maxSnapshotCount: 5 };
    const abandoned = parsePage(
      (
        await invoke('a'.repeat(600), {
          argv: ['abandoned', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
          snapshotRoot: root,
          snapshotLimits: limits,
        })
      ).stdout,
    );
    const abandonedSnapshot = inspectPendingCliOutputCursor(abandoned.page.continuation!.cursor, root);
    expect(abandonedSnapshot).toBeDefined();
    const abandonedId = abandonedSnapshot!.snapshotId;
    const abandonedReservationPath = join(root, `${abandonedId}.reserve`);
    const abandonedReservation = JSON.parse(readFileSync(abandonedReservationPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      abandonedReservationPath,
      JSON.stringify({
        ...abandonedReservation,
        pid: 2_147_483_647,
        processIdentity: undefined,
        state: 'active',
        updatedAtMs: Date.now() - 2 * 60 * 60 * 1_000,
      }),
    );
    rmSync(join(root, `${abandonedId}.json`));
    renameSync(join(root, `${abandonedId}.output`), join(root, `${abandonedId}.tmp`));

    const live = parsePage(
      (
        await invoke('l'.repeat(600), {
          argv: ['live', '--json', '--output-page-size', '256'],
          json: true,
          pageSize: 256,
          snapshotRoot: root,
          snapshotLimits: limits,
        })
      ).stdout,
    );
    expect(existsSync(join(root, `${abandonedId}.tmp`))).toBe(false);
    expect(existsSync(abandonedReservationPath)).toBe(false);

    const liveSnapshot = inspectPendingCliOutputCursor(live.page.continuation!.cursor, root);
    expect(liveSnapshot).toBeDefined();
    const liveId = liveSnapshot!.snapshotId;
    const liveReservationPath = join(root, `${liveId}.reserve`);
    const liveReservation = JSON.parse(readFileSync(liveReservationPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      liveReservationPath,
      JSON.stringify({
        ...liveReservation,
        pid: process.pid,
        processIdentity: undefined,
        state: 'active',
        updatedAtMs: Date.now() - 2 * 60 * 60 * 1_000,
      }),
    );
    rmSync(join(root, `${liveId}.json`));
    renameSync(join(root, `${liveId}.output`), join(root, `${liveId}.tmp`));

    await invoke('n'.repeat(600), {
      argv: ['new', '--json', '--output-page-size', '256'],
      json: true,
      pageSize: 256,
      snapshotRoot: root,
      snapshotLimits: limits,
    });
    expect(existsSync(join(root, `${liveId}.tmp`))).toBe(true);
    expect(existsSync(liveReservationPath)).toBe(true);
  });

  it('validates the public page-size range', () => {
    expect(parseOutputPageSize(String(MIN_OUTPUT_PAGE_SIZE))).toBe(MIN_OUTPUT_PAGE_SIZE);
    expect(parseOutputPageSize(String(MAX_OUTPUT_PAGE_SIZE))).toBe(MAX_OUTPUT_PAGE_SIZE);
    expect(() => parseOutputPageSize('255')).toThrow(/256 through 100000/u);
    expect(() => parseOutputPageSize('100001')).toThrow(/256 through 100000/u);
    expect(() => parseOutputPageSize('1.5')).toThrow(/must be an integer/u);
  });

  it('keeps the published output-page schema synchronized with the runtime contract', () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs', 'schemas', 'cli-output-page.schema.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
      additionalProperties: boolean;
    };

    expect(schema.properties['kind']?.['const']).toBe(CLI_OUTPUT_PAGE_KIND);
    expect(schema.properties['schemaVersion']?.['const']).toBe(CLI_OUTPUT_PAGE_SCHEMA_VERSION);
    expect(schema.properties['agentInstruction']?.['type']).toBe('string');
    expect(schema.required).toEqual(
      expect.arrayContaining(['kind', 'schemaVersion', 'producer', 'command', 'contentType', 'page', 'content']),
    );
    expect(schema.additionalProperties).toBe(false);
  });
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
