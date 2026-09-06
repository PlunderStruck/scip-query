import path from 'node:path';
import { decodeProjectConfig } from '../domain/project-config.js';
import { validateArchitectureConfig, type ArchitectureConfigDiagnostic } from '../domain/architecture-config.js';
import type { ArchitectureConfig } from '../domain/config-types.js';
import { ts } from '@ts-morph/common';
import { typeScriptSnapshotHost } from '../platform/typescript-projects.js';
import { isRecordObject } from '../domain/record-validation.js';

export interface MaintenanceProjectConfig {
  file: string;
  directory: string;
  files: ReadonlySet<string>;
  options: ts.CompilerOptions;
}

export interface MaintenanceProject {
  inputs: Map<string, string>;
  inventory: ReadonlySet<string>;
  configs: MaintenanceProjectConfig[];
  packages: ReadonlyMap<string, string>;
  host: ts.ModuleResolutionHost;
  problems: string[];
  architecture?: ArchitectureConfig;
  resolutionCaches: Map<string, ts.ModuleResolutionCache>;
  fileConfigs: Map<string, MaintenanceProjectConfig[]>;
  ambiguousPackages: Set<string>;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Node10 };

/** Capture the configuration consulted by the compiler alongside the source revision it describes. */
export function maintenanceProject(
  paths: readonly string[],
  sourceFiles: readonly string[],
  read: (file: string) => string | undefined,
): MaintenanceProject {
  const inventory = new Set(paths);
  const inputs = new Map<string, string>();
  const problems: string[] = [];
  const readInput = (file: string): string | undefined => {
    if (inputs.has(file)) return inputs.get(file);
    // Compiler configuration may only read captured JSON metadata, never arbitrary source or the live filesystem.
    if (!file.endsWith('.json') || !inventory.has(file)) return undefined;
    try {
      const content = read(file);
      if (content !== undefined) inputs.set(file, content);
      return content;
    } catch (error) {
      problems.push(`${file}: configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const host = typeScriptSnapshotHost(ts, paths, readInput);
  const directories = sourceDirectories(sourceFiles);
  const configs = readProjectConfigs(inventory, directories, host, problems);
  const ambiguousPackages = new Set<string>();
  const packages = readRepositoryPackages(inventory, directories, readInput, problems, ambiguousPackages);
  for (const file of paths) if (file === 'package.json' || file.endsWith('/package.json')) readInput(file);
  if (inventory.has('.scipquery.json')) readInput('.scipquery.json');
  const capturedHost = typeScriptSnapshotHost(ts, paths, (file) => inputs.get(file));
  return {
    inputs,
    inventory,
    configs,
    packages,
    host: packageHost(capturedHost, packages),
    problems,
    architecture: snapshotArchitecture(inputs.get('.scipquery.json'), problems),
    resolutionCaches: new Map(),
    fileConfigs: new Map(),
    ambiguousPackages,
  };
}

function sourceDirectories(files: readonly string[]): Set<string> {
  const directories = new Set<string>(['.']);
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (!directories.has(directory)) {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return directories;
}

function readProjectConfigs(
  inventory: ReadonlySet<string>,
  directories: ReadonlySet<string>,
  host: ts.ParseConfigHost,
  problems: string[],
): MaintenanceProjectConfig[] {
  const queue = [...directories].flatMap((directory) => {
    const candidates = ['tsconfig.json', 'jsconfig.json'].map((name) => path.posix.join(directory, name));
    return candidates.filter((file) => inventory.has(file)).slice(0, 1);
  });
  const seen = new Set<string>();
  const configs: MaintenanceProjectConfig[] = [];
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index]!;
    if (seen.has(file)) continue;
    seen.add(file);
    const absolute = '/' + file;
    const content = ts.readConfigFile(absolute, host.readFile);
    if (content.error) {
      problems.push(`${file}: ${ts.flattenDiagnosticMessageText(content.error.messageText, ' ')}`);
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(
      content.config,
      host,
      path.posix.dirname(absolute),
      undefined,
      absolute,
    );
    for (const error of parsed.errors) {
      // Empty solution projects and source-only snapshots need not contain executable input files.
      if (error.code !== 18003 && error.code !== 18002)
        problems.push(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
    }
    configs.push({
      file,
      directory: path.posix.dirname(absolute),
      files: new Set(parsed.fileNames),
      options: parsed.options,
    });
    for (const reference of parsed.projectReferences ?? []) {
      const target = reference.path.endsWith('.json')
        ? reference.path
        : path.posix.join(reference.path, 'tsconfig.json');
      queue.push(target.replace(/^\//, ''));
    }
  }
  return configs;
}

function readRepositoryPackages(
  inventory: ReadonlySet<string>,
  directories: ReadonlySet<string>,
  read: (file: string) => string | undefined,
  problems: string[],
  ambiguous: Set<string>,
): Map<string, string> {
  const packages = new Map<string, string>();
  for (const directory of directories) {
    const file = path.posix.join(directory, 'package.json');
    if (!inventory.has(file)) continue;
    try {
      const raw: unknown = JSON.parse(read(file) ?? '{}');
      if (!isRecordObject(raw) || typeof raw.name !== 'string') continue;
      if (ambiguous.has(raw.name)) continue;
      const previous = packages.get(raw.name);
      if (previous && previous !== directory) {
        problems.push(`${file}: repository package name ${raw.name} is also declared in ${previous}.`);
        ambiguous.add(raw.name);
        packages.delete(raw.name);
        continue;
      }
      packages.set(raw.name, directory);
    } catch {
      problems.push(`${file}: malformed package metadata.`);
    }
  }
  return packages;
}

function packageHost(host: ts.ModuleResolutionHost, packages: ReadonlyMap<string, string>): ts.ModuleResolutionHost {
  const canonical = (file: string): string => {
    const marker = '/node_modules/';
    const offset = file.lastIndexOf(marker);
    if (offset < 0) return file;
    const specifier = file.slice(offset + marker.length);
    const name = packageName(specifier);
    const directory = packages.get(name);
    return directory === undefined ? file : path.posix.join('/', directory, specifier.slice(name.length));
  };
  return {
    ...host,
    fileExists: (file) => host.fileExists(canonical(file)),
    readFile: (file) => host.readFile(canonical(file)),
    directoryExists: (file) => file.endsWith('/node_modules') || host.directoryExists?.(canonical(file)) === true,
    realpath: canonical,
  };
}

export function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
}

/** A file can belong to several compiler projects; retain every nearest applicable configuration. */
export function maintenanceFileConfigs(project: MaintenanceProject, file: string): MaintenanceProjectConfig[] {
  const cached = project.fileConfigs.get(file);
  if (cached) return cached;
  const absolute = '/' + file;
  const containing = project.configs.filter((config) => config.files.has(absolute));
  const candidates = containing.length
    ? containing
    : project.configs.filter((config) => absolute.startsWith(config.directory.replace(/\/$/, '') + '/'));
  const nearest = Math.max(...candidates.map((config) => config.directory.length));
  const result = candidates.length
    ? candidates.filter((config) => config.directory.length === nearest)
    : [{ file: '', directory: '/', files: new Set<string>(), options: DEFAULT_OPTIONS }];
  project.fileConfigs.set(file, result);
  return result;
}

export function isInternalSpecifier(project: MaintenanceProject, file: string, specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return true;
  if (project.packages.has(packageName(specifier))) return true;
  return maintenanceFileConfigs(project, file).some((config) =>
    Object.keys(config.options.paths ?? {}).some((pattern) => {
      const [prefix, suffix] = pattern.split('*');
      return suffix === undefined ? specifier === pattern : specifier.startsWith(prefix!) && specifier.endsWith(suffix);
    }),
  );
}

function snapshotArchitecture(raw: string | undefined, problems: string[]): ArchitectureConfig | undefined {
  if (raw === undefined) return undefined;
  const decoded = decodeProjectConfig(raw);
  if (decoded.kind === 'malformed' || decoded.kind === 'unsupported') {
    problems.push(`.scipquery.json: ${decoded.kind === 'malformed' ? decoded.reason : 'unsupported schema version'}`);
    return undefined;
  }
  const diagnostics: ArchitectureConfigDiagnostic[] = [];
  validateArchitectureConfig(decoded.config, diagnostics);
  if (diagnostics.some((item) => item.level === 'error')) {
    problems.push(...diagnostics.map((item) => `.scipquery.json ${item.path}: ${item.message}`));
    return undefined;
  }
  return decoded.config.architecture;
}
