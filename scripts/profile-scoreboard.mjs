#!/usr/bin/env node
import { readFileSync } from 'node:fs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const rows = profileScoreboard(readProfileEvents(args.input), { top: args.top });
  process.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : renderProfileScoreboard(rows));
}

export function parseArgs(argv) {
  const parsed = { input: undefined, top: 20, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') parsed.input = requiredValue(argv[++index], arg);
    else if (arg === '--top') parsed.top = positiveInteger(argv[++index], arg);
    else if (arg === '--json') parsed.json = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!parsed.input) throw new Error('--input requires a value');
  return parsed;
}

export function readProfileEvents(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function profileScoreboard(events, opts = {}) {
  const groups = new Map();
  for (const event of events) {
    const durationMs = numeric(event.durationMs);
    if (durationMs === null) continue;
    const command = typeof event.command === 'string' ? event.command : 'unknown';
    const spanName =
      typeof event.name === 'string' ? event.name : typeof event.phase === 'string' ? event.phase : 'unknown';
    const cacheState = typeof event.cacheState === 'string' ? event.cacheState : 'unknown';
    const key = JSON.stringify([command, spanName, cacheState]);
    const group = groups.get(key) ?? {
      command,
      spanName,
      cacheState,
      totalDurationMs: 0,
      count: 0,
      numericMetadata: {},
    };
    group.totalDurationMs += durationMs;
    group.count += 1;
    for (const [field, value] of Object.entries(event)) {
      const number = numeric(value);
      if (number === null || field === 'durationMs' || field === 'pid') continue;
      group.numericMetadata[field] = (group.numericMetadata[field] ?? 0) + number;
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => right.totalDurationMs - left.totalDurationMs || left.spanName.localeCompare(right.spanName))
    .slice(0, opts.top ?? 20);
}

export function renderProfileScoreboard(rows) {
  const lines = ['command\tcacheState\tspan\tcount\ttotalDurationMs'];
  for (const row of rows) {
    lines.push(`${row.command}\t${row.cacheState}\t${row.spanName}\t${row.count}\t${row.totalDurationMs}`);
  }
  return `${lines.join('\n')}\n`;
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requiredValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
