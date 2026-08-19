import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { CLIENT_SAFE_OUTPUT_BYTES } from '../src/platform/terminal-output.js';

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const cliPath = resolve(projectRoot, 'dist/cli.js');
const scenarios = [
  { name: 'broad-search', transport: 'human', args: ['search', 'output-page-size'] },
  {
    name: 'bounded-inspect',
    transport: 'human',
    args: ['inspect', '--search', 'DEFAULT_OUTPUT_PAGE_SIZE', '--scope', 'src/runtime', '--view', 'behavior'],
  },
  {
    name: 'agent-json-broad-search',
    transport: 'json',
    args: ['search', 'output', '--json', '--result-only', '--compact', '--agent-output'],
  },
] as const;

for (const scenario of scenarios) {
  const pages: string[] = [];
  const content: string[] = [];
  let args: string[] = [...scenario.args];
  let status = 0;
  let stderr = '';

  for (let page = 0; page < 128; page += 1) {
    const invocation = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, SCIP_QUERY_SESSION: '' },
    });
    status = invocation.status ?? 1;
    stderr += invocation.stderr;
    pages.push(invocation.stdout);
    const rendered = scenario.transport === 'json' ? jsonPage(invocation.stdout) : humanPage(invocation.stdout);
    content.push(rendered.content);
    if (status !== 0 || !rendered.cursor) break;
    args = ['continue', rendered.cursor];
  }

  const pageBytes = pages.map((page) => Buffer.byteLength(page));
  const reconstructed = content.join('');
  const accepted =
    status === 0 &&
    pageBytes.every((bytes) => bytes <= CLIENT_SAFE_OUTPUT_BYTES) &&
    (scenario.transport !== 'json' || pages.length <= 16);
  const sectionBytes = scenario.transport === 'human' ? renderedSectionBytes(reconstructed) : {};
  process.stdout.write(
    `${JSON.stringify({
      benchmark: 'agent-output-budget',
      scenario: scenario.name,
      transport: scenario.transport,
      accepted,
      status,
      pages: pages.length,
      maxPageBytes: Math.max(0, ...pageBytes),
      totalRenderedBytes: Buffer.byteLength(reconstructed),
      maxRenderedLineBytes: Math.max(0, ...reconstructed.split('\n').map((line) => Buffer.byteLength(line))),
      sectionBytes,
      outputSha256: createHash('sha256').update(reconstructed).digest('hex'),
      stderr: stderr.trim(),
    })}\n`,
  );
}

function jsonPage(output: string): { content: string; cursor?: string } {
  const decoded = JSON.parse(output) as {
    kind?: string;
    content?: string;
    page?: { continuation?: { cursor?: string } };
  };
  if (decoded.kind !== 'scip-query-output-page') return { content: output };
  if (typeof decoded.content !== 'string') throw new Error('Malformed JSON output page content.');
  const cursor = decoded.page?.continuation?.cursor;
  return {
    content: decoded.content,
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
}

function renderedSectionBytes(output: string): Record<string, number> {
  const starts = [...output.matchAll(/^═══ ([^═]+) ═══$/gmu)].map((match) => ({
    title: match[1]!.trim(),
    offset: match.index,
  }));
  return Object.fromEntries(
    starts.map((start, index) => {
      const end = starts[index + 1]?.offset ?? output.length;
      return [start.title, Buffer.byteLength(output.slice(start.offset, end))];
    }),
  );
}

function humanPage(output: string): { content: string; cursor?: string } {
  if (!output.startsWith('[scip-query output page:')) return { content: output };
  const contentStart = output.indexOf('\n') + 1;
  const incompleteStart = output.lastIndexOf('\n[Incomplete:');
  const completeStart = output.lastIndexOf('\n[scip-query transport complete; evaluate command coverage separately]');
  const contentEnd = Math.max(incompleteStart, completeStart);
  if (contentStart <= 0 || contentEnd < contentStart) throw new Error('Malformed human output page.');
  const cursor = output.match(/\bcontinue ([A-Za-z0-9_.-]+)/u)?.[1];
  return {
    content: output.slice(contentStart, contentEnd),
    ...(cursor ? { cursor } : {}),
  };
}
