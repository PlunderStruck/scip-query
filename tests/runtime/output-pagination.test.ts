import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  parseOutputPageSize,
  runWithCliOutputPagination,
  type CliOutputPageEnvelopeV1,
  type CliOutputPaginationOptions,
} from '../../src/runtime/output-pagination.js';

afterEach(() => {
  vi.restoreAllMocks();
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
  return JSON.parse(output) as CliOutputPageEnvelopeV1;
}

describe('universal CLI output pagination', () => {
  it('retrieves every character across stable pages with exact continuation commands', async () => {
    const content = Array.from({ length: 730 }, (_, index) => String(index % 10)).join('');
    const argv = ['demo', "O'Reilly", '--json'];
    const pages: CliOutputPageEnvelopeV1[] = [];
    let cursor: string | undefined;

    do {
      const result = await invoke(content, {
        argv: [...argv, '--output-page-size', '256', ...(cursor ? ['--output-cursor', cursor] : [])],
        json: true,
        pageSize: 256,
        ...(cursor ? { cursor } : {}),
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
      page: {
        offset: 0,
        returnedCharacters: 256,
        totalCharacters: 730,
        remainingCharacters: 474,
        complete: false,
      },
    });
    expect(pages[0]!.page.continuation?.command).toContain(`'O'"'"'Reilly'`);
    expect(pages[0]!.page.continuation?.command).toContain('--output-cursor');
    expect(pages[2]!.page).toMatchObject({
      offset: 512,
      returnedCharacters: 218,
      remainingCharacters: 0,
      complete: true,
    });
  });

  it('automatically pages oversized human output with the continuation at both boundaries', async () => {
    const content = `${'a'.repeat(DEFAULT_OUTPUT_PAGE_SIZE)}TAIL`;
    const result = await invoke(content, { argv: ['demo', 'target with spaces'] });

    expect(result.stdout.startsWith('[scip-query output page:')).toBe(true);
    expect(result.stdout).toContain('a'.repeat(100));
    expect(result.stdout).not.toContain('TAIL');
    expect(result.stdout.match(/Continue exactly:/gu)).toHaveLength(2);
    expect(result.stdout).toContain("scip-query demo 'target with spaces' --output-page-size 12000 --output-cursor");
  });

  it('keeps unpaged JSON byte-compatible and warns before oversized output with an exact paging command', async () => {
    const payload = `${JSON.stringify({ rows: ['x'.repeat(DEFAULT_OUTPUT_PAGE_SIZE)] })}\n`;
    const result = await invoke(payload, {
      argv: ['demo', '--json', '--compact'],
      json: true,
    });

    expect(result.stdout).toBe(payload);
    expect(result.stderr).toContain('JSON output exceeds 12000 characters');
    expect(result.stderr).toContain('Read every page with: scip-query demo --json --compact --output-page-size 12000');
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

  it('returns a complete page envelope when paging is explicitly requested for small output', async () => {
    const result = await invoke('small\n', {
      argv: ['demo', '--output-page-size', '256'],
      pageSize: 256,
    });

    expect(parsePage(result.stdout)).toMatchObject({
      kind: CLI_OUTPUT_PAGE_KIND,
      page: {
        offset: 0,
        returnedCharacters: 6,
        totalCharacters: 6,
        remainingCharacters: 0,
        complete: true,
      },
      content: 'small\n',
    });
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
          argv: ['demo', '--output-page-size', '256'],
          pageSize: 256,
        })
      ).stdout,
    );
    const cursor = first.page.continuation!.cursor;
    const second = parsePage(
      (
        await invoke(render, {
          argv: ['demo', '--output-page-size', '256', '--output-cursor', cursor],
          pageSize: 256,
          cursor,
        })
      ).stdout,
    );
    const secondCursor = second.page.continuation!.cursor;
    const cursorPayload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      snapshotId: string;
    };
    const snapshotRoot = join(
      tmpdir(),
      `scip-query-output-pages-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
    );
    if (process.platform !== 'win32') {
      expect(statSync(snapshotRoot).mode & 0o777).toBe(0o700);
      expect(statSync(join(snapshotRoot, `${cursorPayload.snapshotId}.output`)).mode & 0o777).toBe(0o600);
      expect(statSync(join(snapshotRoot, `${cursorPayload.snapshotId}.json`)).mode & 0o777).toBe(0o600);
    }
    const third = parsePage(
      (
        await invoke(render, {
          argv: ['demo', '--output-page-size', '256', '--output-cursor', secondCursor],
          pageSize: 256,
          cursor: secondCursor,
        })
      ).stdout,
    );

    expect(executions).toBe(1);
    expect(`${first.content}${second.content}${third.content}`).toBe(`run:1:${'a'.repeat(600)}`);
    expect(third.page.complete).toBe(true);
    expect(existsSync(join(snapshotRoot, `${cursorPayload.snapshotId}.output`))).toBe(false);
    expect(existsSync(join(snapshotRoot, `${cursorPayload.snapshotId}.json`))).toBe(false);
  });

  it('rejects invocation drift, missing snapshots, oversized cursors, and accumulated output overflow', async () => {
    const first = parsePage(
      (
        await invoke('a'.repeat(600), {
          argv: ['demo', '--output-page-size', '256'],
          pageSize: 256,
        })
      ).stdout,
    );
    const cursor = first.page.continuation!.cursor;

    await expect(
      invoke('a'.repeat(600), {
        argv: ['other', '--output-page-size', '256', '--output-cursor', cursor],
        pageSize: 256,
        cursor,
      }),
    ).rejects.toThrow(/different command, working directory, or argument set/u);

    const cursorPayload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      snapshotId: string;
    };
    const snapshotRoot = join(
      tmpdir(),
      `scip-query-output-pages-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
    );
    rmSync(join(snapshotRoot, `${cursorPayload.snapshotId}.json`), { force: true });
    rmSync(join(snapshotRoot, `${cursorPayload.snapshotId}.output`), { force: true });
    await expect(
      invoke('a'.repeat(600), {
        argv: ['demo', '--output-page-size', '256', '--output-cursor', cursor],
        pageSize: 256,
        cursor,
      }),
    ).rejects.toThrow(/snapshot is unavailable.*Restart with: scip-query demo --output-page-size 256/u);

    await expect(invoke('x', { cursor: 'x'.repeat(MAX_OUTPUT_CURSOR_LENGTH + 1) })).rejects.toThrow(/cursor exceeds/u);
    await expect(
      invoke('x'.repeat(301), {
        argv: ['demo', '--output-page-size', '256'],
        pageSize: 256,
        maxOutputCharacters: 300,
      }),
    ).rejects.toThrow(/300-character safety limit/u);
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
    expect(schema.required).toEqual(
      expect.arrayContaining(['kind', 'schemaVersion', 'producer', 'command', 'contentType', 'page', 'content']),
    );
    expect(schema.additionalProperties).toBe(false);
  });
});
