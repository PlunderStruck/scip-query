#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const API_MANIFEST_SCHEMA_VERSION = 1;
export const API_ACCEPTANCE_SCHEMA_VERSION = 1;
export const DEFAULT_API_MANIFEST_PATH = 'docs/api/scip-query.api.json';
export const DEFAULT_API_CHANGE_DIRECTORY = 'docs/api/changes';
export const API_CHANGE_CLASSIFICATIONS = ['additive', 'compatible-correction', 'breaking'];

const declarationPrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

/**
 * An API surface is the compiler-visible declarations reachable through a
 * package's public export paths. Its defining characteristic is that downstream
 * TypeScript programs can depend on it without importing repository internals.
 */
export function buildApiSurface({
  projectRoot,
  packageJsonPath = join(projectRoot, 'package.json'),
  declarationRoot = join(projectRoot, 'dist'),
}) {
  const packageJson = readJson(packageJsonPath, 'package manifest');
  if (!isRecord(packageJson) || typeof packageJson.name !== 'string' || !isRecord(packageJson.exports)) {
    throw new Error(`${packageJsonPath} must define a package name and object-valued exports.`);
  }

  const entries = {};
  const publicDeclarationPaths = new Set();
  const resolveExport = createDeclarationResolver();
  for (const [exportPath, target] of Object.entries(packageJson.exports).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const typesTarget = typeTargetForExport(target);
    if (typesTarget === null) continue;
    const declarationPath = resolvePackageTarget(projectRoot, typesTarget);
    assertInsideDirectory(declarationRoot, declarationPath, `Type declaration for ${exportPath}`);
    if (!existsSync(declarationPath) || !statSync(declarationPath).isFile()) {
      throw new Error(`Missing declaration path for ${exportPath}: ${typesTarget}`);
    }
    publicDeclarationPaths.add(declarationPath);
    const source = readFileSync(declarationPath, 'utf8');
    entries[exportPath] = {
      types: normalizeDeclarationPath(relative(projectRoot, declarationPath)),
      exports: extractPublicExports(source, declarationPath, resolveExport),
      declaration: normalizeDeclarationText(source, declarationPath),
    };
  }

  if (Object.keys(entries).length === 0) {
    throw new Error(`${packageJsonPath} exposes no TypeScript declaration paths.`);
  }

  const internalDeclarations = declarationFiles(declarationRoot)
    .filter((file) => !publicDeclarationPaths.has(file))
    .map((file) => ({
      module: normalizeDeclarationPath(relative(declarationRoot, file)),
      declaration: normalizeDeclarationText(readFileSync(file, 'utf8'), file),
    }))
    .sort((left, right) =>
      left.module === right.module
        ? left.declaration.localeCompare(right.declaration)
        : left.module.localeCompare(right.module),
    );

  return {
    packageName: packageJson.name,
    entries,
    internalDeclarations,
  };
}

export function createApiManifest(surface) {
  const digest = digestApiSurface(surface);
  return {
    kind: 'scip-query-api-manifest',
    schemaVersion: API_MANIFEST_SCHEMA_VERSION,
    digest,
    surface,
  };
}

export function digestApiSurface(surface) {
  return createHash('sha256').update(stableJson(surface)).digest('hex');
}

export function normalizeDeclarationText(source, fileName = 'api.d.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = sourceFile.statements.map((statement) => normalizeNamedBindings(statement));
  return (
    statements
      .map((statement) => declarationPrinter.printNode(ts.EmitHint.Unspecified, statement, sourceFile).trim())
      .filter(Boolean)
      .join('\n\n')
      .replaceAll('\r\n', '\n')
      .replace(/[ \t]+$/gm, '')
      .trim() + '\n'
  );
}

export function extractPublicExports(source, fileName = 'api.d.ts', resolveExport) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = declarationStatementsByName(sourceFile);
  const imports = importBindingsByName(sourceFile);
  const importDetails = importBindingDetailsByName(sourceFile);
  const exports = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined) {
        throw new Error(`Unsupported export-star declaration in ${fileName}; public names must be explicit.`);
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        const declaration = declarations.get(localName);
        const resolved =
          resolveExport && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? resolveExport(fileName, statement.moduleSpecifier.text, localName)
            : resolveImportedBinding(fileName, importDetails.get(localName), resolveExport);
        exports.push({
          name: element.name.text,
          kind:
            statement.isTypeOnly || element.isTypeOnly
              ? 'type'
              : (resolved?.kind ?? exportedDeclarationKind(declaration)),
          signature: declaration
            ? declaration
                .map((node) =>
                  declarationPrinter
                    .printNode(ts.EmitHint.Unspecified, normalizeNamedBindings(node), sourceFile)
                    .trim(),
                )
                .join('\n')
            : (resolved?.signature ?? imports.get(localName) ?? `unresolved ${localName}`),
        });
      }
      continue;
    }

    if (!hasExportModifier(statement)) continue;
    for (const name of declarationNames(statement)) {
      exports.push({
        name,
        kind: exportedDeclarationKind([statement]),
        signature: declarationPrinter
          .printNode(ts.EmitHint.Unspecified, normalizeNamedBindings(statement), sourceFile)
          .trim(),
      });
    }
  }

  const merged = new Map();
  for (const item of exports) {
    const previous = merged.get(item.name);
    if (!previous) {
      merged.set(item.name, item);
      continue;
    }
    const signatures = [...new Set([...previous.signature.split('\n--- overload ---\n'), item.signature])];
    merged.set(item.name, {
      name: item.name,
      kind: previous.kind === item.kind ? item.kind : 'value',
      signature: signatures.join('\n--- overload ---\n'),
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.name === right.name ? left.kind.localeCompare(right.kind) : left.name.localeCompare(right.name),
  );
}

export function compareApiSurfaces(previous, current) {
  const changes = [];
  const previousEntries = previous.entries ?? {};
  const currentEntries = current.entries ?? {};
  const entryPaths = new Set([...Object.keys(previousEntries), ...Object.keys(currentEntries)]);

  for (const exportPath of [...entryPaths].sort()) {
    const before = previousEntries[exportPath];
    const after = currentEntries[exportPath];
    if (!before && after) {
      changes.push(change('additive', 'entry-added', exportPath, `Added public declaration path ${exportPath}.`));
      continue;
    }
    if (before && !after) {
      changes.push(change('breaking', 'entry-removed', exportPath, `Removed public declaration path ${exportPath}.`));
      continue;
    }
    if (before.types !== after.types) {
      changes.push(
        change(
          'breaking',
          'declaration-target-changed',
          exportPath,
          `Declaration target changed from ${before.types} to ${after.types}.`,
        ),
      );
    }

    const previousExports = new Map(before.exports.map((item) => [item.name, item]));
    const currentExports = new Map(after.exports.map((item) => [item.name, item]));
    const names = new Set([...previousExports.keys(), ...currentExports.keys()]);
    let changedNamedDeclaration = false;
    for (const name of [...names].sort()) {
      const oldExport = previousExports.get(name);
      const newExport = currentExports.get(name);
      if (!oldExport && newExport) {
        changedNamedDeclaration = true;
        changes.push(change('additive', 'export-added', `${exportPath}:${name}`, `Added export ${name}.`));
      } else if (oldExport && !newExport) {
        changedNamedDeclaration = true;
        changes.push(change('breaking', 'export-removed', `${exportPath}:${name}`, `Removed export ${name}.`));
      } else if (oldExport && newExport && stableJson(oldExport) !== stableJson(newExport)) {
        changedNamedDeclaration = true;
        const classification = classifySignatureChange(oldExport.signature, newExport.signature);
        changes.push(
          change(
            classification,
            'signature-changed',
            `${exportPath}:${name}`,
            `${name} changed from ${oneLine(oldExport.signature)} to ${oneLine(newExport.signature)}.`,
          ),
        );
      }
    }
    if (!changedNamedDeclaration && before.declaration !== after.declaration) {
      changes.push(
        change(
          'uncertain',
          'entry-declaration-changed',
          exportPath,
          `Referenced declarations changed for ${exportPath}; review their variance and runtime meaning.`,
        ),
      );
    }
  }

  changes.push(
    ...compareReferencedDeclarations(previous.internalDeclarations ?? [], current.internalDeclarations ?? []),
  );

  return {
    classification: highestAutomaticClassification(changes),
    changes,
  };
}

export function checkApiContract({
  projectRoot,
  manifestPath = join(projectRoot, DEFAULT_API_MANIFEST_PATH),
  changeDirectory = join(projectRoot, DEFAULT_API_CHANGE_DIRECTORY),
}) {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Missing API manifest ${manifestPath}. Run npm run api:update -- --classification ... --reason "...".`,
    );
  }
  const baseline = readApiManifest(manifestPath);
  const current = createApiManifest(buildApiSurface({ projectRoot }));
  const baselineDigest = digestApiSurface(baseline.surface);
  if (baseline.digest !== baselineDigest) {
    throw new Error(`API manifest digest mismatch in ${manifestPath}; regenerate it instead of editing it by hand.`);
  }
  requireAcceptanceRecord(changeDirectory, baseline.digest);

  const diff = compareApiSurfaces(baseline.surface, current.surface);
  if (diff.changes.length > 0) {
    throw new Error(
      [
        `Public TypeScript API drift (${diff.classification}):`,
        ...formatApiChanges(diff.changes),
        'Review the change, then run npm run api:update -- --classification <additive|compatible-correction|breaking> --reason "<why>".',
      ].join('\n'),
    );
  }
  return { manifest: baseline, diff };
}

export function updateApiContract({
  projectRoot,
  classification,
  reason,
  now = () => new Date(),
  manifestPath = join(projectRoot, DEFAULT_API_MANIFEST_PATH),
  changeDirectory = join(projectRoot, DEFAULT_API_CHANGE_DIRECTORY),
}) {
  if (!API_CHANGE_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`--classification must be one of: ${API_CHANGE_CLASSIFICATIONS.join(', ')}.`);
  }
  if (typeof reason !== 'string' || reason.trim().length < 12) {
    throw new Error('--reason must explain the compatibility decision in at least 12 characters.');
  }

  const packageJson = readJson(join(projectRoot, 'package.json'), 'package manifest');
  const current = createApiManifest(buildApiSurface({ projectRoot }));
  const previous = existsSync(manifestPath) ? readApiManifest(manifestPath) : null;
  const diff = previous
    ? compareApiSurfaces(previous.surface, current.surface)
    : {
        classification: 'uncertain',
        changes: [change('uncertain', 'baseline-created', '<package>', 'Created the first API declaration baseline.')],
      };

  if (diff.changes.length === 0) {
    throw new Error('The generated API surface already matches the committed manifest.');
  }
  enforceClassification(diff.classification, classification);

  const record = {
    kind: 'scip-query-api-acceptance',
    schemaVersion: API_ACCEPTANCE_SCHEMA_VERSION,
    baselineDigest: current.digest,
    previousDigest: previous?.digest ?? null,
    packageVersion: isRecord(packageJson) && typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
    classification,
    automaticClassification: diff.classification,
    reason: reason.trim(),
    acceptedAt: now().toISOString(),
    changes: diff.changes,
  };

  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(changeDirectory, { recursive: true });
  writeFileSync(manifestPath, `${stableJson(current, 2)}\n`, 'utf8');
  const recordPath = join(changeDirectory, `${current.digest.slice(0, 16)}.json`);
  if (existsSync(recordPath)) {
    const existing = readJson(recordPath, 'API acceptance record');
    if (stableJson(existing) !== stableJson(record)) {
      throw new Error(`Refusing to replace existing API acceptance record ${recordPath}.`);
    }
  } else {
    writeFileSync(recordPath, `${stableJson(record, 2)}\n`, 'utf8');
  }
  return { manifest: current, record, recordPath, diff };
}

export function classifySignatureChange(previousSignature, currentSignature) {
  const previous = parseSingleDeclaration(previousSignature);
  const current = parseSingleDeclaration(currentSignature);
  if (previous && current && ts.isInterfaceDeclaration(previous) && ts.isInterfaceDeclaration(current)) {
    const oldMembers = interfaceMembers(previous);
    const newMembers = interfaceMembers(current);
    for (const [name, member] of oldMembers) {
      const next = newMembers.get(name);
      if (!next || next !== member) return 'breaking';
    }
    const additions = [...newMembers].filter(([name]) => !oldMembers.has(name));
    if (additions.length > 0 && additions.every(([, member]) => member.startsWith('?'))) return 'additive';
  }
  if (previousSignature === currentSignature) return 'none';
  return 'breaking';
}

function compareReferencedDeclarations(previousDeclarations, currentDeclarations) {
  const changes = [];
  const previousModules = new Map(previousDeclarations.map((item) => [item.module, item]));
  const currentModules = new Map(currentDeclarations.map((item) => [item.module, item]));
  const modules = new Set([...previousModules.keys(), ...currentModules.keys()]);

  for (const module of [...modules].sort()) {
    const before = previousModules.get(module);
    const after = currentModules.get(module);
    if (!before || !after) {
      changes.push(
        change(
          'uncertain',
          'referenced-declaration-module-changed',
          module,
          before
            ? `Referenced declaration module ${module} was removed or renamed.`
            : `Referenced declaration module ${module} was added or renamed.`,
        ),
      );
      continue;
    }
    if (before.declaration === after.declaration) continue;

    const oldExports = new Map(
      extractPublicExports(before.declaration, before.module).map((item) => [item.name, item]),
    );
    const newExports = new Map(extractPublicExports(after.declaration, after.module).map((item) => [item.name, item]));
    const names = new Set([...oldExports.keys(), ...newExports.keys()]);
    let explained = false;
    for (const name of [...names].sort()) {
      const oldExport = oldExports.get(name);
      const newExport = newExports.get(name);
      if (!oldExport && newExport) {
        explained = true;
        changes.push(
          change('additive', 'referenced-export-added', `${module}:${name}`, `Added referenced declaration ${name}.`),
        );
      } else if (oldExport && !newExport) {
        explained = true;
        changes.push(
          change(
            'breaking',
            'referenced-export-removed',
            `${module}:${name}`,
            `Removed referenced declaration ${name}.`,
          ),
        );
      } else if (oldExport && newExport && stableJson(oldExport) !== stableJson(newExport)) {
        explained = true;
        const classification =
          oldExport.kind === newExport.kind
            ? classifySignatureChange(oldExport.signature, newExport.signature)
            : 'breaking';
        changes.push(
          change(
            classification,
            'referenced-signature-changed',
            `${module}:${name}`,
            `${name} changed from ${oneLine(oldExport.signature)} to ${oneLine(newExport.signature)}.`,
          ),
        );
      }
    }
    if (!explained) {
      changes.push(
        change(
          'uncertain',
          'referenced-declaration-changed',
          module,
          `Non-exported declarations changed in referenced module ${module}.`,
        ),
      );
    }
  }
  return changes;
}

function normalizeNamedBindings(statement) {
  if (
    (ts.isExportDeclaration(statement) || ts.isImportDeclaration(statement)) &&
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    const moduleSpecifier = ts.factory.createStringLiteral(normalizeModuleSpecifier(statement.moduleSpecifier.text));
    if (ts.isExportDeclaration(statement)) {
      const clause =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? ts.factory.updateNamedExports(
              statement.exportClause,
              [...statement.exportClause.elements].sort((left, right) => left.name.text.localeCompare(right.name.text)),
            )
          : statement.exportClause;
      return ts.factory.updateExportDeclaration(
        statement,
        statement.modifiers,
        statement.isTypeOnly,
        clause,
        moduleSpecifier,
        statement.attributes,
      );
    }
    const clause = statement.importClause;
    const bindings =
      clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? ts.factory.updateNamedImports(
            clause.namedBindings,
            [...clause.namedBindings.elements].sort((left, right) => left.name.text.localeCompare(right.name.text)),
          )
        : clause?.namedBindings;
    const updatedClause = clause
      ? ts.factory.updateImportClause(clause, clause.phaseModifier, clause.name, bindings)
      : undefined;
    return ts.factory.updateImportDeclaration(
      statement,
      statement.modifiers,
      updatedClause,
      moduleSpecifier,
      statement.attributes,
    );
  }
  if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    return ts.factory.updateExportDeclaration(
      statement,
      statement.modifiers,
      statement.isTypeOnly,
      ts.factory.updateNamedExports(
        statement.exportClause,
        [...statement.exportClause.elements].sort((left, right) => left.name.text.localeCompare(right.name.text)),
      ),
      statement.moduleSpecifier,
      statement.attributes,
    );
  }
  return statement;
}

function declarationStatementsByName(sourceFile) {
  const result = new Map();
  for (const statement of sourceFile.statements) {
    for (const name of declarationNames(statement)) {
      const list = result.get(name) ?? [];
      list.push(statement);
      result.set(name, list);
    }
  }
  return result;
}

function importBindingsByName(sourceFile) {
  const result = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = normalizeModuleSpecifier(statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (clause?.name) result.set(clause.name.text, `default import from ${module}`);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        result.set(element.name.text, `import ${element.propertyName?.text ?? element.name.text} from ${module}`);
      }
    }
  }
  return result;
}

function importBindingDetailsByName(sourceFile) {
  const result = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) {
      result.set(clause.name.text, { moduleSpecifier, importedName: 'default' });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        result.set(element.name.text, {
          moduleSpecifier,
          importedName: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  }
  return result;
}

function createDeclarationResolver() {
  const sourceCache = new Map();
  const resultCache = new Map();

  function resolveExport(fromFile, moduleSpecifier, exportName, visited = new Set()) {
    const declarationPath = resolveDeclarationModule(fromFile, moduleSpecifier);
    if (declarationPath === null) return null;
    const cacheKey = `${declarationPath}\0${exportName}`;
    if (resultCache.has(cacheKey)) return resultCache.get(cacheKey);
    if (visited.has(cacheKey)) return null;
    visited.add(cacheKey);
    if (!existsSync(declarationPath)) return null;

    let sourceFile = sourceCache.get(declarationPath);
    if (!sourceFile) {
      sourceFile = ts.createSourceFile(
        declarationPath,
        readFileSync(declarationPath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      sourceCache.set(declarationPath, sourceFile);
    }

    const declarations = declarationStatementsByName(sourceFile);
    const imports = importBindingDetailsByName(sourceFile);
    let resolved = declarationResult(declarations.get(exportName), sourceFile);
    if (!resolved) {
      resolved = resolveImportedBinding(
        declarationPath,
        imports.get(exportName),
        (nestedFile, nestedModule, nestedName) => resolveExport(nestedFile, nestedModule, nestedName, new Set(visited)),
      );
    }

    if (!resolved) {
      for (const statement of sourceFile.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause)
        ) {
          continue;
        }
        const element = statement.exportClause.elements.find((item) => item.name.text === exportName);
        if (!element) continue;
        const localName = element.propertyName?.text ?? element.name.text;
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          resolved = resolveExport(declarationPath, statement.moduleSpecifier.text, localName, new Set(visited));
        } else {
          resolved =
            declarationResult(declarations.get(localName), sourceFile) ??
            resolveImportedBinding(declarationPath, imports.get(localName), (nestedFile, nestedModule, nestedName) =>
              resolveExport(nestedFile, nestedModule, nestedName, new Set(visited)),
            );
        }
        if (resolved) {
          if (statement.isTypeOnly || element.isTypeOnly) resolved = { ...resolved, kind: 'type' };
          break;
        }
      }
    }

    resultCache.set(cacheKey, resolved);
    return resolved;
  }

  return resolveExport;
}

function resolveImportedBinding(fromFile, detail, resolveExport) {
  if (!detail || !resolveExport) return null;
  return resolveExport(fromFile, detail.moduleSpecifier, detail.importedName);
}

function declarationResult(declarations, sourceFile) {
  if (!declarations?.length) return null;
  return {
    kind: exportedDeclarationKind(declarations),
    signature: declarations
      .map((node) =>
        declarationPrinter.printNode(ts.EmitHint.Unspecified, normalizeNamedBindings(node), sourceFile).trim(),
      )
      .join('\n'),
  };
}

function resolveDeclarationModule(fromFile, moduleSpecifier) {
  if (!moduleSpecifier.startsWith('.')) return null;
  const candidate = resolve(dirname(fromFile), moduleSpecifier);
  if (candidate.endsWith('.js')) return `${candidate.slice(0, -3)}.d.ts`;
  if (candidate.endsWith('.d.ts')) return candidate;
  return `${candidate}.d.ts`;
}

function declarationNames(statement) {
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) => (ts.isIdentifier(declaration.name) ? declaration.name.text : null))
      .filter(Boolean);
  }
  return [];
}

function exportedDeclarationKind(declarations) {
  const declaration = declarations?.[0];
  if (!declaration) return 'value';
  if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) return 'type';
  if (ts.isClassDeclaration(declaration)) return 'class';
  if (ts.isFunctionDeclaration(declaration)) return 'function';
  if (ts.isEnumDeclaration(declaration)) return 'enum';
  if (ts.isVariableStatement(declaration)) return 'const';
  return 'value';
}

function hasExportModifier(statement) {
  return Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function parseSingleDeclaration(signature) {
  const sourceFile = ts.createSourceFile('signature.d.ts', signature, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sourceFile.statements.length === 1 ? sourceFile.statements[0] : null;
}

function interfaceMembers(declaration) {
  const result = new Map();
  for (const member of declaration.members) {
    if (!('name' in member) || !member.name) continue;
    const name =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText();
    const printed = declarationPrinter.printNode(ts.EmitHint.Unspecified, member, declaration.getSourceFile()).trim();
    result.set(name, `${member.questionToken ? '?' : '!'}${printed.replace(/\s+/g, ' ')}`);
  }
  return result;
}

function enforceClassification(automatic, selected) {
  if (automatic === 'breaking' && selected === 'additive') {
    throw new Error('The declaration diff contains a conservative breaking change and cannot be accepted as additive.');
  }
  if (automatic === 'uncertain' && selected === 'additive') {
    throw new Error(
      'The declaration diff is uncertain and cannot be accepted as additive without a compatibility correction.',
    );
  }
}

function requireAcceptanceRecord(changeDirectory, digest) {
  const recordPath = join(changeDirectory, `${digest.slice(0, 16)}.json`);
  if (!existsSync(recordPath)) {
    throw new Error(`API manifest ${digest} has no acceptance record at ${recordPath}.`);
  }
  const record = readJson(recordPath, 'API acceptance record');
  if (
    !isRecord(record) ||
    record.kind !== 'scip-query-api-acceptance' ||
    record.schemaVersion !== API_ACCEPTANCE_SCHEMA_VERSION ||
    record.baselineDigest !== digest ||
    !API_CHANGE_CLASSIFICATIONS.includes(record.classification)
  ) {
    throw new Error(`Malformed or mismatched API acceptance record ${recordPath}.`);
  }
}

function readApiManifest(path) {
  const value = readJson(path, 'API manifest');
  if (
    !isRecord(value) ||
    value.kind !== 'scip-query-api-manifest' ||
    value.schemaVersion !== API_MANIFEST_SCHEMA_VERSION ||
    typeof value.digest !== 'string' ||
    !isRecord(value.surface)
  ) {
    throw new Error(`Malformed or unsupported API manifest ${path}.`);
  }
  return value;
}

function normalizeDeclarationPath(path) {
  return path
    .split(sep)
    .join('/')
    .replace(/-([A-Za-z0-9_-]{8})(?=\.d\.ts$)/, '-<hash>');
}

function normalizeModuleSpecifier(specifier) {
  return specifier.replace(/-([A-Za-z0-9_-]{8})(?=\.js$)/, '-<hash>');
}

function declarationFiles(root) {
  if (!existsSync(root)) throw new Error(`Missing declaration root ${root}; run npm run build first.`);
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...declarationFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files.sort();
}

function typeTargetForExport(target) {
  if (typeof target === 'string') return target.endsWith('.d.ts') ? target : null;
  if (!isRecord(target)) return null;
  if (typeof target.types === 'string') return target.types;
  for (const value of Object.values(target)) {
    const nested = typeTargetForExport(value);
    if (nested !== null) return nested;
  }
  return null;
}

function resolvePackageTarget(projectRoot, target) {
  return resolve(projectRoot, target.startsWith('./') ? target.slice(2) : target);
}

function assertInsideDirectory(directory, path, label) {
  const root = resolve(directory);
  const candidate = resolve(path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes declaration root ${root}: ${candidate}`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function change(classification, kind, target, message) {
  return { classification, kind, target, message };
}

function highestAutomaticClassification(changes) {
  const rank = { none: 0, additive: 1, uncertain: 2, breaking: 3 };
  return changes.reduce(
    (highest, item) => (rank[item.classification] > rank[highest] ? item.classification : highest),
    'none',
  );
}

function formatApiChanges(changes) {
  const visible = changes.slice(0, 20).map((item) => `- [${item.classification}] ${item.target}: ${item.message}`);
  if (changes.length > visible.length) visible.push(`- ... ${changes.length - visible.length} more change(s)`);
  return visible;
}

function oneLine(value) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
}

function stableJson(value, space) {
  return JSON.stringify(sortJson(value), null, space);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(argv) {
  const command = argv[0] ?? 'check';
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function runCli() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'check') {
    const result = checkApiContract({ projectRoot });
    console.log(
      `Public TypeScript API matches ${result.manifest.digest.slice(0, 16)} (${Object.keys(result.manifest.surface.entries).length} paths).`,
    );
    return;
  }
  if (command === 'report') {
    console.log(`${stableJson(createApiManifest(buildApiSurface({ projectRoot })), 2)}\n`);
    return;
  }
  if (command === 'update') {
    const result = updateApiContract({
      projectRoot,
      classification: options.classification,
      reason: options.reason,
    });
    console.log(
      `Accepted ${result.diff.classification} API diff as ${result.record.classification}; wrote ${relative(projectRoot, result.recordPath)}.`,
    );
    return;
  }
  throw new Error(`Unknown command ${command}; expected check, report, or update.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
