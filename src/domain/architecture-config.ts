import type { ProjectConfig } from './config-types.js';
import { isRecordObject } from './record-validation.js';

export interface ArchitectureConfigDiagnostic {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

interface BoundaryInventory {
  names: Set<string>;
  paths: Set<string>;
}

export function validateArchitectureConfig(config: ProjectConfig, diagnostics: ArchitectureConfigDiagnostic[]): void {
  if (config.architecture === undefined) return;
  if (!isRecordObject(config.architecture)) {
    diagnostics.push({ level: 'error', path: 'architecture', message: 'Must be an object.' });
    return;
  }
  const architecture = config.architecture;
  const boundaries = architecture.boundaries as unknown;
  if (!Array.isArray(boundaries) || boundaries.length === 0) {
    diagnostics.push({ level: 'error', path: 'architecture.boundaries', message: 'Must be a non-empty array.' });
    return;
  }

  const inventory: BoundaryInventory = { names: new Set(), paths: new Set() };
  for (const [index, boundary] of boundaries.entries()) {
    validateBoundary(boundary, `architecture.boundaries[${index}]`, inventory, diagnostics);
  }
  validateDependencies(architecture.allowedDependencies, inventory.names, diagnostics);
  validateArchitectureOptions(architecture, diagnostics);
  validateCompletePolicy(architecture, inventory.names, diagnostics);
}

function validateBoundary(
  boundary: unknown,
  path: string,
  inventory: BoundaryInventory,
  diagnostics: ArchitectureConfigDiagnostic[],
): void {
  if (!isRecordObject(boundary)) {
    diagnostics.push({ level: 'error', path, message: 'Architecture boundary must be an object.' });
    return;
  }
  const name = boundary.name;
  if (typeof name !== 'string' || name.trim() === '') {
    diagnostics.push({ level: 'error', path: `${path}.name`, message: 'Boundary name is required.' });
  } else if (inventory.names.has(name)) {
    diagnostics.push({ level: 'error', path: `${path}.name`, message: `Duplicate boundary name: ${name}` });
  } else {
    inventory.names.add(name);
  }
  // An unchecked typo would silently choose directory granularity in the detector.
  const subUnits = boundary.subUnits;
  if (subUnits !== undefined && subUnits !== 'directory' && subUnits !== 'file') {
    diagnostics.push({ level: 'error', path: `${path}.subUnits`, message: "Must be 'directory' or 'file'." });
  }
  validateOptionalCount(boundary.maxFiles, `${path}.maxFiles`, diagnostics);
  validateBoundaryPaths(boundary.paths, `${path}.paths`, inventory.paths, diagnostics);
}

function validateBoundaryPaths(
  paths: unknown,
  path: string,
  seen: Set<string>,
  diagnostics: ArchitectureConfigDiagnostic[],
): void {
  if (!Array.isArray(paths) || paths.length === 0) {
    diagnostics.push({ level: 'error', path, message: 'Boundary paths must be a non-empty array.' });
    return;
  }
  for (const [index, pattern] of paths.entries()) {
    const patternPath = `${path}[${index}]`;
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      diagnostics.push({ level: 'error', path: patternPath, message: 'Boundary path must be a non-empty string.' });
      continue;
    }
    if (!isSupportedArchitecturePath(pattern)) {
      diagnostics.push({
        level: 'error',
        path: patternPath,
        message: 'Boundary path must be project-relative and may use only one trailing /* or /** glob.',
      });
    }
    if (seen.has(pattern)) {
      diagnostics.push({ level: 'error', path: patternPath, message: `Duplicate boundary path: ${pattern}` });
    } else {
      seen.add(pattern);
    }
  }
}

function validateDependencies(
  dependencies: unknown,
  boundaryNames: Set<string>,
  diagnostics: ArchitectureConfigDiagnostic[],
): void {
  if (dependencies === undefined) return;
  if (!isRecordObject(dependencies)) {
    diagnostics.push({
      level: 'error',
      path: 'architecture.allowedDependencies',
      message: 'Must be an object keyed by boundary name.',
    });
    return;
  }
  for (const [source, targets] of Object.entries(dependencies)) {
    validateDependencyRow(source, targets, boundaryNames, diagnostics);
  }
}

function validateDependencyRow(
  source: string,
  targets: unknown,
  boundaryNames: Set<string>,
  diagnostics: ArchitectureConfigDiagnostic[],
): void {
  const path = `architecture.allowedDependencies.${source}`;
  if (!boundaryNames.has(source)) {
    diagnostics.push({ level: 'error', path, message: `Unknown source boundary: ${source}` });
  }
  if (!Array.isArray(targets)) {
    diagnostics.push({ level: 'error', path, message: 'Dependency row must be an array.' });
    return;
  }
  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const targetPath = `${path}[${index}]`;
    if (typeof target !== 'string' || target.trim() === '') {
      diagnostics.push({ level: 'error', path: targetPath, message: 'Target boundary name is required.' });
    } else if (!boundaryNames.has(target)) {
      diagnostics.push({ level: 'error', path: targetPath, message: `Unknown target boundary: ${target}` });
    } else if (seen.has(target)) {
      diagnostics.push({ level: 'error', path: targetPath, message: `Duplicate target boundary: ${target}` });
    } else {
      seen.add(target);
    }
  }
}

function validateArchitectureOptions(
  architecture: Record<string, unknown>,
  diagnostics: ArchitectureConfigDiagnostic[],
): void {
  for (const flag of [
    'requireAcyclic',
    'requireCompleteCoverage',
    'requireResolvedBoundaries',
    'requireMinimalPolicy',
  ]) {
    validateOptionalBoolean(architecture[flag], `architecture.${flag}`, diagnostics);
  }
  for (const limit of ['maxBoundaryFanOut', 'maxBoundaryFiles']) {
    validateOptionalCount(architecture[limit], `architecture.${limit}`, diagnostics);
  }
  const testPaths = architecture.testPaths;
  if (testPaths !== undefined && (!Array.isArray(testPaths) || testPaths.some((p) => typeof p !== 'string'))) {
    diagnostics.push({ level: 'error', path: 'architecture.testPaths', message: 'Must be an array of strings.' });
  }
}

function validateCompletePolicy(
  architecture: Record<string, unknown>,
  boundaryNames: Set<string>,
  diagnostics: ArchitectureConfigDiagnostic[],
): void {
  validateOptionalBoolean(architecture.requireCompletePolicy, 'architecture.requireCompletePolicy', diagnostics);
  if (architecture.requireCompletePolicy !== true) return;
  const rows = isRecordObject(architecture.allowedDependencies) ? architecture.allowedDependencies : {};
  for (const name of [...boundaryNames].sort()) {
    if (Object.hasOwn(rows, name)) continue;
    diagnostics.push({
      level: 'error',
      path: `architecture.allowedDependencies.${name}`,
      message: 'A dependency row is required by architecture.requireCompletePolicy.',
    });
  }
}

function validateOptionalBoolean(value: unknown, path: string, diagnostics: ArchitectureConfigDiagnostic[]): void {
  if (value !== undefined && typeof value !== 'boolean') {
    diagnostics.push({ level: 'error', path, message: 'Must be a boolean.' });
  }
}

function validateOptionalCount(value: unknown, path: string, diagnostics: ArchitectureConfigDiagnostic[]): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
    diagnostics.push({ level: 'error', path, message: 'Must be a non-negative integer.' });
  }
}

function isSupportedArchitecturePath(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/');
  if (/^(?:\/|[a-z]:)/i.test(normalized) || normalized === '.' || normalized === '..') return false;
  if (normalized.split('/').includes('..')) return false;
  const literalPrefix = normalized.replace(/\/\*\*?$/, '');
  return literalPrefix.length > 0 && !/[*?[\]]/.test(literalPrefix);
}
