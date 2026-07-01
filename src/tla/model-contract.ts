import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isRecord, stringArray } from '../storage/evidence-payload.js';

export type TlaCheckerMode = 'auto' | 'sany' | 'tlc' | 'apalache' | 'none';

export interface TlaVariableMapping {
  code: string[];
  aliases: string[];
  projection?: string;
}

export interface TlaActionMapping {
  code: string[];
  reads: string[];
  writes: string[];
  calls: string[];
  allowUnknown: boolean;
}

export interface TlaTraceStep {
  action: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  code?: string;
}

export interface TlaModelContract {
  module?: string;
  config?: string;
  scope: string[];
  variables: Record<string, TlaVariableMapping>;
  actions: Record<string, TlaActionMapping>;
  invariants: string[];
  traces: string[];
}

export interface LoadedTlaContract {
  contract: TlaModelContract;
  mapPath: string;
  mapDir: string;
}

export interface TlaContractLoadResult {
  loaded?: LoadedTlaContract;
  errors: string[];
}

export interface TlaModuleFacts {
  path: string;
  variables: string[];
  operators: string[];
  text: string;
}

const CHECKER_MODES = new Set<TlaCheckerMode>(['auto', 'sany', 'tlc', 'apalache', 'none']);
const TLA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isTlaCheckerMode(value: string): value is TlaCheckerMode {
  return CHECKER_MODES.has(value as TlaCheckerMode);
}

export function loadTlaModelContract(projectRoot: string, mapPath: string): TlaContractLoadResult {
  const errors: string[] = [];
  const resolvedMapPath = resolveProjectPath(projectRoot, mapPath);
  if (!resolvedMapPath) {
    return { errors: [`map path escapes project root: ${mapPath}`] };
  }
  if (!existsSync(resolvedMapPath)) {
    return { errors: [`map file not found: ${mapPath}`] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedMapPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errors: [`map file is not valid JSON: ${message}`] };
  }

  const contract = parseContract(raw, errors);
  if (!contract) return { errors };
  return {
    loaded: {
      contract,
      mapPath: resolvedMapPath,
      mapDir: dirname(resolvedMapPath),
    },
    errors,
  };
}

export function resolveProjectPath(projectRoot: string, path: string | undefined): string | null {
  if (!path) return null;
  const resolved = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  return isInsideProject(projectRoot, resolved) ? resolved : null;
}

export function resolveContractPath(projectRoot: string, mapDir: string, path: string | undefined): string | null {
  if (!path) return null;
  if (isAbsolute(path)) {
    const resolved = resolve(path);
    return isInsideProject(projectRoot, resolved) ? resolved : null;
  }

  const projectRelative = resolve(projectRoot, path);
  if (isInsideProject(projectRoot, projectRelative) && existsSync(projectRelative)) return projectRelative;

  const mapRelative = resolve(mapDir, path);
  if (isInsideProject(projectRoot, mapRelative) && existsSync(mapRelative)) return mapRelative;

  const fallback = isInsideProject(projectRoot, projectRelative) ? projectRelative : mapRelative;
  return isInsideProject(projectRoot, fallback) ? fallback : null;
}

function isInsideProject(projectRoot: string, resolved: string): boolean {
  const rel = relative(projectRoot, resolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function readTlaModuleFacts(projectRoot: string, modulePath: string): TlaModuleFacts | null {
  const absolutePath = resolveProjectPath(projectRoot, modulePath);
  if (!absolutePath || !existsSync(absolutePath)) return null;
  const text = readFileSync(absolutePath, 'utf8');
  return {
    path: absolutePath,
    text,
    variables: parseTlaVariables(text),
    operators: parseTlaOperators(text),
  };
}

export function loadTraceSteps(projectRoot: string, tracePath: string): { steps: TlaTraceStep[]; errors: string[] } {
  const absolutePath = resolveProjectPath(projectRoot, tracePath);
  if (!absolutePath) return { steps: [], errors: [`trace path escapes project root: ${tracePath}`] };
  if (!existsSync(absolutePath)) return { steps: [], errors: [`trace file not found: ${tracePath}`] };

  try {
    const raw = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
    const stepsRaw = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.steps) ? raw.steps : null;
    if (!stepsRaw) return { steps: [], errors: [`trace file must be an array or an object with a steps array`] };
    const steps: TlaTraceStep[] = [];
    const errors: string[] = [];
    for (const [index, step] of stepsRaw.entries()) {
      if (!isRecord(step) || typeof step.action !== 'string') {
        errors.push(`trace step ${index} must include an action string`);
        continue;
      }
      steps.push({
        action: step.action,
        before: isRecord(step.before) ? step.before : undefined,
        after: isRecord(step.after) ? step.after : undefined,
        code: typeof step.code === 'string' ? step.code : undefined,
      });
    }
    return { steps, errors };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { steps: [], errors: [`trace file is not valid JSON: ${message}`] };
  }
}

function parseContract(raw: unknown, errors: string[]): TlaModelContract | null {
  if (!isRecord(raw)) {
    errors.push('map file must contain a JSON object');
    return null;
  }

  const variables = parseVariables(raw.variables, errors);
  const actions = parseActions(raw.actions, variables, errors);
  const contract: TlaModelContract = {
    module: optionalString(raw.module, 'module', errors),
    config: optionalString(raw.config, 'config', errors),
    scope: stringArray(raw.scope) ?? [],
    variables,
    actions,
    invariants: stringArray(raw.invariants) ?? [],
    traces: stringArray(raw.traces) ?? [],
  };
  validateScope(raw.scope, errors);
  return errors.length === 0 ? contract : null;
}

function parseVariables(raw: unknown, errors: string[]): Record<string, TlaVariableMapping> {
  if (!isRecord(raw)) {
    errors.push('variables must be an object keyed by TLA+ variable name');
    return {};
  }

  const out: Record<string, TlaVariableMapping> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!TLA_NAME_PATTERN.test(name)) {
      errors.push(`invalid TLA+ variable name: ${name}`);
      continue;
    }
    if (!isRecord(value)) {
      errors.push(`variables.${name} must be an object`);
      continue;
    }
    const code = stringOrStringArray(value.code);
    if (!code || code.length === 0) {
      errors.push(`variables.${name}.code must name at least one TypeScript referent`);
      continue;
    }
    const aliases = stringArray(value.aliases) ?? [];
    out[name] = {
      code,
      aliases: [...new Set([name, ...aliases])],
      projection: typeof value.projection === 'string' ? value.projection : undefined,
    };
  }
  return out;
}

function parseActions(
  raw: unknown,
  variables: Record<string, TlaVariableMapping>,
  errors: string[],
): Record<string, TlaActionMapping> {
  if (!isRecord(raw)) {
    errors.push('actions must be an object keyed by TLA+ action name');
    return {};
  }

  const variableNames = new Set(Object.keys(variables));
  const out: Record<string, TlaActionMapping> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!TLA_NAME_PATTERN.test(name)) {
      errors.push(`invalid TLA+ action name: ${name}`);
      continue;
    }
    if (!isRecord(value)) {
      errors.push(`actions.${name} must be an object`);
      continue;
    }
    const code = stringOrStringArray(value.code);
    if (!code || code.length === 0) {
      errors.push(`actions.${name}.code must name at least one TypeScript referent`);
      continue;
    }
    const reads = stringArray(value.reads) ?? [];
    const writes = stringArray(value.writes) ?? [];
    const calls = stringArray(value.calls) ?? [];
    for (const variable of [...reads, ...writes]) {
      if (!variableNames.has(variable)) errors.push(`actions.${name} references unknown variable: ${variable}`);
    }
    out[name] = {
      code,
      reads,
      writes,
      calls,
      allowUnknown: value.allowUnknown === true,
    };
  }
  return out;
}

function parseTlaVariables(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*VARIABLES?\s+([^\n]+)/gm)) {
    const declaration = match[1] ?? '';
    for (const name of declaration.split(',')) {
      const cleaned = name.trim();
      if (TLA_NAME_PATTERN.test(cleaned)) names.add(cleaned);
    }
  }
  return [...names].sort();
}

function parseTlaOperators(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*==/gm)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

function optionalString(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  errors.push(`${field} must be a string when present`);
  return undefined;
}

function stringOrStringArray(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  return stringArray(value);
}

function validateScope(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!stringArray(value)) errors.push('scope must be an array of strings when present');
}

export function defaultMapPathForSpec(specPath: string): string {
  const base = specPath.replace(/\.tla$/i, '');
  return `${base}.scip-tla.json`;
}
