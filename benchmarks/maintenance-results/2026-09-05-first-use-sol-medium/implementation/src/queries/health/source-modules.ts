import path from 'node:path';
import type { ArchitectureConfig } from '../../domain/config-types.js';
import { stronglyConnectedComponents } from '../../analysis/strongly-connected-components.js';
import type { MaintenanceBindingFacts, MaintenanceFunctionBindings } from '../../source/ast/maintenance-bindings.js';
import type { SourceImport } from '../../source/ast/maintenance-imports.js';
import { architectureBoundaryForFile } from '../internal/architecture-policy.js';
import { productionImports } from './source-dependencies.js';
import { compareFindings, type SourceFinding } from './source-findings.js';

export interface SourceModuleSubject {
  id: string;
  basis: 'declared-boundary' | 'directory';
  files: string[];
  consumers: string[];
  dependencies: string[];
  findingIds: string[];
  primaryFindingIds: string[];
  highestPriority: SourceFinding['rule'];
  interpretation: string;
}

/** Group findings for planning; directory membership is location evidence, not a discovered responsibility. */
export function sourceModuleSubjects(
  files: readonly string[],
  imports: readonly SourceImport[],
  findings: readonly SourceFinding[],
  config?: ArchitectureConfig,
): SourceModuleSubject[] {
  const groups = new Map<string, SourceModuleSubject>();
  const owners = new Map<string, string>();
  for (const file of files) {
    const boundary = architectureBoundaryForFile(config, file);
    const id = boundary ? `boundary:${boundary}` : `directory:${path.posix.dirname(file)}`;
    owners.set(file, id);
    if (!groups.has(id))
      groups.set(id, {
        id,
        basis: boundary ? 'declared-boundary' : 'directory',
        files: [],
        consumers: [],
        dependencies: [],
        findingIds: [],
        primaryFindingIds: [],
        highestPriority: 'complexity',
        interpretation:
          'Grouping identifies declared membership or a shared directory. Review the observed contracts before changing ownership.',
      });
    groups.get(id)!.files.push(file);
  }
  const outgoing = new Map<string, Set<string>>(),
    incoming = new Map<string, Set<string>>();
  for (const edge of productionImports(imports, config)) {
    if (edge.resolution !== 'internal' || !edge.target) continue;
    const from = owners.get(edge.file),
      to = owners.get(edge.target);
    if (!from || !to || from === to) continue;
    const targets = outgoing.get(from) ?? new Set<string>();
    targets.add(edge.target);
    outgoing.set(from, targets);
    const sources = incoming.get(to) ?? new Set<string>();
    sources.add(edge.file);
    incoming.set(to, sources);
  }
  const sorted = [...findings].filter((finding) => finding.status !== 'resolved').sort(compareFindings);
  const rank = new Map(sorted.map((finding, index) => [finding.id, index]));
  for (const finding of sorted) {
    const primary = finding.sites.map((site) => owners.get(site.file)).find((id) => id !== undefined);
    if (primary) groups.get(primary)!.primaryFindingIds.push(finding.id);
    for (const id of new Set(
      finding.sites.map((site) => owners.get(site.file)).filter((id): id is string => Boolean(id)),
    )) {
      const group = groups.get(id)!;
      if (!group.findingIds.length) group.highestPriority = finding.rule;
      group.findingIds.push(finding.id);
    }
  }
  return [...groups.values()]
    .filter((group) => group.findingIds.length)
    .map((group) => ({
      ...group,
      files: group.files.sort(),
      consumers: [...(incoming.get(group.id) ?? [])].sort(),
      dependencies: [...(outgoing.get(group.id) ?? [])].sort(),
    }))
    .sort(
      (a, b) =>
        (rank.get(a.primaryFindingIds[0]!) ?? Infinity) - (rank.get(b.primaryFindingIds[0]!) ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
}

/** Independent implementations, dependencies and named consumer sets are leads for a responsibility review. */
export function responsibilityFindings(facts: readonly MaintenanceBindingFacts[]): SourceFinding[] {
  const consumers = facts.flatMap((item) => item.consumers);
  const findings: SourceFinding[] = [];
  for (const fileFacts of facts) {
    if (fileFacts.functions.length < 4) continue;
    const file = fileFacts.functions[0]!.fn.file;
    const groups = independentFunctionGroups(fileFacts.functions)
      .map((group) => {
        const exports = new Set(group.flatMap((item) => item.exports));
        return {
          functions: group.filter((item) => item.exports.length && item.fn.tokenCount >= 60),
          dependencies: [...new Set(group.flatMap((item) => item.dependencies))],
          consumers: consumers.filter((item) => item.target === file && (exports.has(item.name) || item.name === '*')),
        };
      })
      .filter((group) => group.functions.length >= 2 && group.dependencies.length && group.consumers.length);
    const independent = groups.filter((group) =>
      groups.every(
        (other) =>
          group === other ||
          !other.consumers.some((consumer) => group.consumers.some((item) => item.file === consumer.file)),
      ),
    );
    if (independent.length < 2) continue;
    findings.push({
      id: `responsibility:${file}`,
      rule: 'responsibility',
      evidence: 'candidate',
      score: independent.length,
      summary: `${file} contains ${independent.length} substantial exported function groups with separate observed dependencies and named consumers.`,
      sites: independent.flatMap((group) =>
        group.functions.map(({ fn }) => ({ file, line: fn.startLine, name: fn.name })),
      ),
      details: independent
        .map(
          (group, index) =>
            `Group ${index + 1}: ${group.functions.map((item) => item.fn.name).join(', ')}; dependencies: ${group.dependencies.join(', ')}; named importers: ${group.consumers.map((item) => `${item.file}:${item.line} (${item.name})`).join(', ')}.`,
        )
        .concat([
          'No shared same-file binding or imported module connects these groups in the covered top-level functions. Nested closures contribute their binding references to their containing function.',
          'A shared public contract can justify keeping these groups together. Classes, indirect re-exports, dynamic consumers, external users and runtime resource identity are not established by this provider. Read those contracts before proposing a split.',
        ]),
    });
  }
  return findings;
}

function independentFunctionGroups(functions: readonly MaintenanceFunctionBindings[]): MaintenanceFunctionBindings[][] {
  const graph = new Map(functions.map((_, index) => [String(index), new Set<string>()]));
  const owners = new Map<string, string>();
  functions.forEach((fn, index) => {
    const current = String(index);
    for (const key of [
      ...[fn.declaration, ...fn.bindings].map((offset) => `binding:${offset}`),
      ...fn.dependencies.map((file) => `import:${file}`),
    ]) {
      const previous = owners.get(key);
      if (previous !== undefined) {
        graph.get(current)!.add(previous);
        graph.get(previous)!.add(current);
      } else owners.set(key, current);
    }
  });
  return stronglyConnectedComponents(graph).components.map((members) =>
    members.map((member) => functions[Number(member)]!),
  );
}
