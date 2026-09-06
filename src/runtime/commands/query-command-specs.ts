import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import { cleanupQueryCommandDescriptors } from '../query-commands/cleanup.js';
import { coreQueryCommandDescriptors } from '../query-commands/core.js';
import { graphQueryCommandDescriptors } from '../query-commands/graph.js';
import { healthQueryCommandDescriptors } from '../query-commands/health.js';
import { impactQueryCommandDescriptors } from '../query-commands/impact.js';
import { navigationQueryCommandDescriptors } from '../query-commands/navigation.js';
import { planningQueryCommandDescriptors } from '../query-commands/planning.js';

const queryCommandOrder = [
  'stats',
  'files',
  'session',
  'inspect',
  'search',
  'methods',
  'refs',
  'evidence',
  'deps',
  'rdeps',
  'system',
  'surface',
  'dead',
  'hotspots',
  'imports',
  'imported-by',
  'unused-imports',
  'outline',
  'members',
  'fan-in',
  'fan-out',
  'coupling',
  'cycles',
  'architecture',
  'bottlenecks',
  'by-kind',
  'kind-counts',
  'dependency-depth',
  'hierarchy',
  'entrypoints',
  'entry-map',
  'call-graph',
  'similar',
  'similar-files',
  'react-component-duplicates',
  'react-hook-candidates',
  'react-large-component-pressure',
  'vue-component-duplicates',
  'vue-composable-candidates',
  'vue-large-view-pressure',
  'locality-candidates',
  'affected',
  'change-surface',
  'cleanup-plan',
  'co-change',
  'recent-duplicates',
  'doc-drift',
  'unused-params',
  'incomplete-migration',
  'context',
  'drift',
  'passthrough-candidates',
  'slice-cohesion',
  'code',
  'complexity',
  'dependence-slice',
  'redundant-reexports',
  'duplicate-bodies',
  'twin-drift',
  'not-implemented',
  'decorative-checkers',
  'test-quality',
  'similar-signatures',
] as const;

const queryCommandFamilies = [
  coreQueryCommandDescriptors,
  navigationQueryCommandDescriptors,
  graphQueryCommandDescriptors,
  cleanupQueryCommandDescriptors,
  impactQueryCommandDescriptors,
  planningQueryCommandDescriptors,
  healthQueryCommandDescriptors,
];

const familyDescriptors = queryCommandFamilies.flat();
const QUERY_COMMANDS_BY_ID = new Map(familyDescriptors.map((descriptor) => [descriptor.id, descriptor]));

for (const descriptor of familyDescriptors) {
  if (!queryCommandOrder.includes(descriptor.id as (typeof queryCommandOrder)[number])) {
    throw new Error(`Query command descriptor is not ordered: ${descriptor.id}`);
  }
}

export const orderedQueryCommandDescriptors: CommandDescriptor[] = queryCommandOrder.map((id) =>
  queryCommandDescriptor(id),
);

export function queryCommandDescriptor(id: string): CommandDescriptor {
  const descriptor = QUERY_COMMANDS_BY_ID.get(id);
  if (!descriptor) throw new Error(`Unknown query command descriptor: ${id}`);
  return descriptor;
}
