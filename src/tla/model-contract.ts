import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isRecord, stringArray } from '../storage/evidence-payload.js';
import { parseSanyXmlFacts, type SanyActionFacts } from './sany-facts.js';

export type TlaCheckerMode = 'auto' | 'sany' | 'tlc' | 'apalache' | 'none';

export interface TlaResourceBinding {
  /**
   * Expression or suffix matched textually against a filesystem call's first
   * argument (e.g. `"lockPath"` matches `rmSync(lockPath, ...)`). Evidence
   * tier for a resulting write/read stays `static-action` — this is a
   * textual containment check, not a resolved value.
   */
  path: string;
}

/**
 * Exempts a variable's `missing-referent`/`invalid-referent-kind` findings
 * (P5.2 / followup #17) — for state materialized only via a process exit
 * code, a literal, or another concept with no direct stored-field twin.
 * Distinct from `TlaActionMapping.waive`, which exempts read/write facts,
 * not referent resolution.
 */
export interface TlaVariableWaiver {
  reason: string;
}

export interface TlaVariableMapping {
  code: string[];
  aliases: string[];
  projection?: string;
  /** Binds this variable to filesystem state (lock files, published artifacts). */
  resource?: TlaResourceBinding;
  waive?: TlaVariableWaiver;
}

export interface TlaActionMapping {
  code: string[];
  reads: string[];
  writes: string[];
  calls: string[];
  waive?: TlaFactWaiver;
}

export interface TlaFactWaiver {
  reads: string[];
  writes: string[];
  reason: string;
  legacy?: boolean;
}

export interface TlaTraceStep {
  action: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  code?: string;
}

/**
 * P5.7 / followup #19: controls the unmapped-write sweep's granularity.
 * `'scope-files'` (default, current behavior) scans every `scope` file's
 * full range — every function touching a modeled variable anywhere in
 * scope must be mapped as an action. `'actions'` opts out of that sweep
 * entirely, relying only on the per-action write/read checks — for models
 * whose scope files legitimately contain unrelated code the mapping was
 * never meant to cover in full.
 */
export type TlaUnmappedWriteScope = 'actions' | 'scope-files';

export interface TlaModelContract {
  module?: string;
  config?: string;
  scope: string[];
  variables: Record<string, TlaVariableMapping>;
  actions: Record<string, TlaActionMapping>;
  invariants: string[];
  traces: string[];
  unmappedWriteScope: TlaUnmappedWriteScope;
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
  modelParse: 'sany' | 'regex-fallback';
  variables: string[];
  operators: string[];
  actions: SanyActionFacts[];
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
    modelParse: 'regex-fallback',
    text,
    variables: parseTlaVariables(text),
    operators: parseTlaOperators(text),
    actions: [],
  };
}

export function readTlaModuleFactsFromSanyXml(
  projectRoot: string,
  modulePath: string,
  xml: string,
): TlaModuleFacts | null {
  const absolutePath = resolveProjectPath(projectRoot, modulePath);
  if (!absolutePath || !existsSync(absolutePath)) return null;
  const text = readFileSync(absolutePath, 'utf8');
  const facts = parseSanyXmlFacts(xml);
  return {
    path: absolutePath,
    modelParse: 'sany',
    text,
    variables: facts.variables,
    operators: facts.operators,
    actions: facts.actions,
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

/**
 * Dedupes trace input paths by resolved absolute location (P5.5 / followup
 * #20) — `contract.traces` and `--trace` naming the same file (relative vs.
 * absolute, or simply repeated) must not double-count that file's steps.
 * Preserves the first-seen original string (so relative-path resolution
 * behavior at load time is unchanged) and drops later duplicates.
 */
export function dedupeTracePaths(projectRoot: string, paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const resolved = resolveProjectPath(projectRoot, path) ?? path;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(path);
  }
  return out;
}

function parseContract(raw: unknown, errors: string[]): TlaModelContract | null {
  if (!isRecord(raw)) {
    errors.push('map file must contain a JSON object');
    return null;
  }

  const variables = parseVariables(raw.variables, errors);
  validateNoVariableCollisions(variables, errors);
  const actions = parseActions(raw.actions, variables, errors);
  const contract: TlaModelContract = {
    module: optionalString(raw.module, 'module', errors),
    config: optionalString(raw.config, 'config', errors),
    scope: stringArray(raw.scope) ?? [],
    variables,
    actions,
    invariants: stringArray(raw.invariants) ?? [],
    traces: stringArray(raw.traces) ?? [],
    unmappedWriteScope: parseUnmappedWriteScope(raw.unmappedWriteScope, errors),
  };
  validateScope(raw.scope, errors);
  return errors.length === 0 ? contract : null;
}

function parseUnmappedWriteScope(raw: unknown, errors: string[]): TlaUnmappedWriteScope {
  if (raw === undefined) return 'scope-files';
  if (raw === 'actions' || raw === 'scope-files') return raw;
  errors.push(`unmappedWriteScope must be "actions" or "scope-files" when present`);
  return 'scope-files';
}

/**
 * P5.3 / followup #18: two variables sharing an alias (or the same
 * resource path suffix) makes every matching write/read ambiguous — the
 * conformance scanner would attribute it to both. Fail the load instead of
 * silently misattributing.
 */
function validateNoVariableCollisions(variables: Record<string, TlaVariableMapping>, errors: string[]): void {
  reportCollisions(variables, errors, 'alias', (mapping) => mapping.aliases);
  reportCollisions(variables, errors, 'resource path', (mapping) => (mapping.resource ? [mapping.resource.path] : []));
}

function reportCollisions(
  variables: Record<string, TlaVariableMapping>,
  errors: string[],
  label: string,
  keysFor: (mapping: TlaVariableMapping) => readonly string[],
): void {
  const owners = new Map<string, string[]>();
  for (const [name, mapping] of Object.entries(variables)) {
    for (const key of keysFor(mapping)) {
      const existing = owners.get(key);
      if (existing) existing.push(name);
      else owners.set(key, [name]);
    }
  }
  for (const [key, names] of owners) {
    if (names.length < 2) continue;
    errors.push(
      `variables ${[...new Set(names)].sort().join(', ')} share ${label} "${key}" — conformance scanning cannot attribute a matching write/read to one variable unambiguously`,
    );
  }
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
    const resource = parseResourceBinding(value.resource, name, errors);
    const waive = parseVariableWaiver(value.waive, name, errors);
    out[name] = {
      code,
      aliases: [...new Set([name, ...aliases])],
      projection: typeof value.projection === 'string' ? value.projection : undefined,
      ...(resource ? { resource } : {}),
      ...(waive ? { waive } : {}),
    };
  }
  return out;
}

function parseResourceBinding(raw: unknown, variableName: string, errors: string[]): TlaResourceBinding | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push(`variables.${variableName}.resource must be an object when present`);
    return undefined;
  }
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path) {
    errors.push(`variables.${variableName}.resource.path must be a non-empty string`);
    return undefined;
  }
  return { path };
}

function parseVariableWaiver(raw: unknown, variableName: string, errors: string[]): TlaVariableWaiver | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push(`variables.${variableName}.waive must be an object when present`);
    return undefined;
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!reason) {
    errors.push(`variables.${variableName}.waive.reason must be a non-empty string`);
    return undefined;
  }
  return { reason };
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
    const waive = parseActionWaiver(
      value.waive,
      value.allowUnknown === true,
      reads,
      writes,
      variableNames,
      name,
      errors,
    );
    out[name] = {
      code,
      reads,
      writes,
      calls,
      ...(waive ? { waive } : {}),
    };
  }
  return out;
}

function parseActionWaiver(
  raw: unknown,
  allowUnknown: boolean,
  reads: readonly string[],
  writes: readonly string[],
  variableNames: ReadonlySet<string>,
  actionName: string,
  errors: string[],
): TlaFactWaiver | undefined {
  if (isRecord(raw)) {
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (!reason) errors.push(`actions.${actionName}.waive.reason must be a non-empty string`);
    const waivedReads = stringArray(raw.reads) ?? [];
    const waivedWrites = stringArray(raw.writes) ?? [];
    if (waivedReads.length === 0 && waivedWrites.length === 0) {
      errors.push(`actions.${actionName}.waive must list reads or writes`);
    }
    validateWaivedVariables(actionName, 'reads', waivedReads, variableNames, errors);
    validateWaivedVariables(actionName, 'writes', waivedWrites, variableNames, errors);
    return {
      reads: [...new Set(waivedReads)],
      writes: [...new Set(waivedWrites)],
      reason,
    };
  }

  if (raw !== undefined) {
    errors.push(`actions.${actionName}.waive must be an object when present`);
  }

  if (allowUnknown) {
    return {
      reads: [...new Set(reads)],
      writes: [...new Set(writes)],
      reason: 'legacy allowUnknown',
      legacy: true,
    };
  }

  return undefined;
}

function validateWaivedVariables(
  actionName: string,
  field: 'reads' | 'writes',
  variables: readonly string[],
  variableNames: ReadonlySet<string>,
  errors: string[],
): void {
  for (const variable of variables) {
    if (!variableNames.has(variable)) {
      errors.push(`actions.${actionName}.waive.${field} references unknown variable: ${variable}`);
    }
  }
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

export function readTlaConfigInvariants(configPath: string | null | undefined): string[] {
  if (!configPath || !existsSync(configPath)) return [];
  const text = readFileSync(configPath, 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*INVARIANT\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
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
