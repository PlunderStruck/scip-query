import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLI_JSON_ENVELOPE_KIND,
  CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
  createCliJsonEnvelope,
  decodeCliJsonEnvelope,
  requireCompatibleCliJsonEnvelope,
  serializeCliJsonEnvelope,
} from '../../src/runtime/cli-json-envelope.js';
import { printJsonEnvelope } from '../../src/runtime/command-kit/command-execution.js';
import { commandDescriptors } from '../../src/runtime/commands/command-descriptors.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', name), 'utf8')) as unknown;

describe('CLI JSON envelope compatibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it('decodes the committed legacy and current fixtures without discarding additive fields', () => {
    const legacy = requireCompatibleCliJsonEnvelope(fixture('cli-json-envelope-v0.json'));
    const current = requireCompatibleCliJsonEnvelope(fixture('cli-json-envelope-v1.json'));

    expect(legacy).toMatchObject({ kind: 'legacy', schemaVersion: 0, envelope: { command: 'stats' } });
    expect(current).toMatchObject({
      kind: 'supported',
      schemaVersion: 1,
      envelope: {
        producer: { name: 'scip-query', version: '0.19.5' },
        command: 'stats',
        resultSchemaVersion: 1,
        additiveFixtureField: { ignoredByTolerantConsumers: true },
      },
    });
  });

  it('keeps the current additive envelope readable by a legacy tolerant consumer', () => {
    const current = fixture('cli-json-envelope-v1.json') as Record<string, unknown>;
    const legacyConsumer = (value: Record<string, unknown>) => ({
      command: value['command'],
      result: value['result'],
    });

    expect(legacyConsumer(current)).toEqual({
      command: 'stats',
      result: { documents: 12, symbols: 34 },
    });
  });

  it('rejects unsupported future versions with producer context', () => {
    const future = {
      ...(fixture('cli-json-envelope-v1.json') as Record<string, unknown>),
      schemaVersion: 2,
      producer: { name: 'scip-query', version: '2.0.0' },
    };

    expect(decodeCliJsonEnvelope(future)).toEqual({
      kind: 'unsupported',
      schemaVersion: 2,
      direction: 'future',
      producer: { name: 'scip-query', version: '2.0.0' },
    });
    expect(() => requireCompatibleCliJsonEnvelope(future)).toThrow(
      /schemaVersion 2 from scip-query@2\.0\.0.*supports.*schemaVersion 1/,
    );
  });

  it('rejects malformed identities and result schema versions at the boundary', () => {
    const current = fixture('cli-json-envelope-v1.json') as Record<string, unknown>;

    expect(decodeCliJsonEnvelope({ ...current, producer: { name: 'other', version: '1.0.0' } })).toMatchObject({
      kind: 'malformed',
      reason: expect.stringContaining('producer'),
    });
    expect(decodeCliJsonEnvelope({ ...current, resultSchemaVersion: 0 })).toMatchObject({
      kind: 'malformed',
      reason: expect.stringContaining('resultSchemaVersion'),
    });
    expect(decodeCliJsonEnvelope({ ...current, resultSchemaVersion: 2 })).toEqual({
      kind: 'unsupported-result',
      schemaVersion: 1,
      command: 'stats',
      resultSchemaVersion: 2,
      supportedResultSchemaVersions: [1],
    });
    expect(() => requireCompatibleCliJsonEnvelope({ ...current, resultSchemaVersion: 2 })).toThrow(
      /Unsupported resultSchemaVersion 2.*"stats".*supports 1/,
    );
    expect(decodeCliJsonEnvelope({ ...current, result: undefined, command: '' })).toMatchObject({
      kind: 'malformed',
      reason: expect.stringContaining('command'),
    });
  });

  it('serializes compact and pretty representations with identical meaning', () => {
    const envelope = createCliJsonEnvelope({
      producerVersion: '1.2.3',
      command: 'stats',
      args: [],
      options: { json: true },
      result: { documents: 1 },
    });

    const compact = serializeCliJsonEnvelope(envelope, true);
    const pretty = serializeCliJsonEnvelope(envelope, false);
    expect(compact).not.toContain('\n');
    expect(pretty).toContain('\n');
    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty));
  });

  it('stamps every descriptor-backed public JSON command through the shared renderer', () => {
    const jsonCommands = commandDescriptors.filter(
      (descriptor) =>
        !descriptor.hidden && descriptor.options?.some((option) => option.flags.split(/[ ,]+/).includes('--json')),
    );
    expect(jsonCommands.length).toBeGreaterThan(50);

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    for (const descriptor of jsonCommands) {
      printJsonEnvelope(descriptor.id, [], { json: true, compact: true }, {});
      const payload = JSON.parse(writes.at(-1)!) as Record<string, unknown>;
      expect(payload, descriptor.id).toMatchObject({
        kind: CLI_JSON_ENVELOPE_KIND,
        schemaVersion: CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
        producer: { name: 'scip-query', version: expect.any(String) },
        command: descriptor.id,
        resultSchemaVersion: 1,
      });
    }
  });

  it('keeps the published JSON Schema synchronized with the runtime contract', () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs', 'schemas', 'cli-json-envelope.schema.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
      additionalProperties: boolean;
    };
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      files: string[];
    };

    expect(schema.properties['kind']?.['const']).toBe(CLI_JSON_ENVELOPE_KIND);
    expect(schema.properties['schemaVersion']?.['const']).toBe(CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'kind',
        'schemaVersion',
        'producer',
        'command',
        'resultSchemaVersion',
        'args',
        'options',
        'result',
      ]),
    );
    expect(schema.additionalProperties).toBe(true);
    expect(packageJson.files).toContain('docs/schemas/**/*');
  });

  it('leaves only explicitly classified non-public JSON emitters outside the shared renderer', () => {
    const handlers = readFileSync(join(process.cwd(), 'src', 'runtime', 'commands', 'command-handlers.ts'), 'utf8');
    const cliSupport = readFileSync(join(process.cwd(), 'src', 'runtime', 'cli-support.ts'), 'utf8');
    const hooks = readFileSync(join(process.cwd(), 'src', 'runtime', 'agent-hooks.ts'), 'utf8');
    const isolated = readFileSync(join(process.cwd(), 'src', 'runtime', 'isolated-analysis-runner.ts'), 'utf8');

    expect(handlers).not.toContain('console.log(JSON.stringify');
    expect(cliSupport).not.toContain('console.log(JSON.stringify');
    expect(hooks.match(/writeSerializedJson\(JSON\.stringify/g)).toHaveLength(3);
    expect(isolated.match(/writeSerializedJson\(JSON\.stringify/g)).toHaveLength(1);
  });
});
