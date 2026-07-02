#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_SOURCE = 'src/storage/evidence-products.ts';
const DEFAULT_DOC = 'docs/architecture/evidence-cache-invalidation.md';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = checkEvidenceManifestDoc({
    sourceText: readFileSync(args.source, 'utf8'),
    docText: readFileSync(args.doc, 'utf8'),
  });
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  }
}

export function checkEvidenceManifestDoc({ sourceText, docText }) {
  const entries = manifestKeys(sourceText);
  const docEntries = docManifestRows(docText);
  const missing = entries.filter((entry) => !docEntries.has(entry));
  const missingStalenessTest = [...docEntries]
    .filter((entry) => entries.includes(entry))
    .filter((entry) => !rowForEntry(docText, entry)?.includes('tests/'));
  return {
    ok: missing.length === 0 && missingStalenessTest.length === 0,
    missing,
    missingStalenessTest,
  };
}

export function manifestKeys(sourceText) {
  const result = [];
  const pattern = /\b(file|project)Manifest\('([^']+)'/g;
  let match;
  while ((match = pattern.exec(sourceText))) {
    result.push(`${match[1]}:${match[2]}`);
  }
  return [...new Set(result)].sort();
}

function docManifestRows(docText) {
  const result = new Set();
  for (const line of docText.split('\n')) {
    const match = line.match(/^\|\s*`(file|project):([^`]+)`\s*\|/);
    if (match) result.add(`${match[1]}:${match[2]}`);
  }
  return result;
}

function rowForEntry(docText, entry) {
  return docText.split('\n').find((line) => line.startsWith(`| \`${entry}\``));
}

function parseArgs(argv) {
  const parsed = { source: DEFAULT_SOURCE, doc: DEFAULT_DOC };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') parsed.source = resolve(requiredValue(argv[++index], arg));
    else if (arg === '--doc') parsed.doc = resolve(requiredValue(argv[++index], arg));
    else throw new Error(`unknown option: ${arg}`);
  }
  return parsed;
}

function requiredValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
