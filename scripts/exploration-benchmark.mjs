#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluateExplorationTrial } from './exploration-benchmark-core.mjs';

const [definitionPath, trialPath, ...rest] = process.argv.slice(2);
if (!definitionPath || !trialPath || rest.some((arg) => arg !== '--json')) {
  process.stderr.write('Usage: node scripts/exploration-benchmark.mjs <definition.json> <trial.json> [--json]\n');
  process.exitCode = 2;
} else {
  try {
    const result = evaluateExplorationTrial(readJson(definitionPath), readJson(trialPath));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
