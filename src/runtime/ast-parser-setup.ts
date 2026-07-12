import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupportedLanguage } from '../domain/types.js';
import { probeAstLanguageRuntime, resetAstRuntimeProbeCache } from '../source/ast/ast-runtime.js';
import type { AstLanguage } from '../source/ast/ast-language.js';

const GRAMMAR_PACKAGES: Partial<Record<SupportedLanguage, { ast: AstLanguage; packages: string[] }>> = {
  typescript: { ast: 'typescript', packages: ['tree-sitter-typescript'] },
  javascript: { ast: 'javascript', packages: ['tree-sitter-javascript'] },
  java: { ast: 'java', packages: ['tree-sitter-java'] },
  scala: { ast: 'scala', packages: ['tree-sitter-scala'] },
  kotlin: { ast: 'kotlin', packages: ['tree-sitter-kotlin'] },
  rust: { ast: 'rust', packages: ['tree-sitter-rust'] },
  python: { ast: 'python', packages: ['tree-sitter-python'] },
  ruby: { ast: 'ruby', packages: ['tree-sitter-ruby'] },
  cpp: { ast: 'cpp', packages: ['tree-sitter-cpp'] },
  c: { ast: 'c', packages: ['tree-sitter-c'] },
  csharp: { ast: 'csharp', packages: ['tree-sitter-c-sharp'] },
  php: { ast: 'php', packages: ['tree-sitter-php'] },
};

export interface AstParserSetupResult {
  supportedLanguages: SupportedLanguage[];
  availableBefore: SupportedLanguage[];
  installed: string[];
  availableAfter: SupportedLanguage[];
  unavailable: SupportedLanguage[];
  attempted: boolean;
  error?: string;
}

interface AstParserSetupRuntime {
  probe(language: AstLanguage): boolean;
  install(packageRoot: string, packages: readonly string[]): { ok: boolean; error?: string };
  resetProbe(): void;
}

export function astParserPackagesForLanguages(
  languages: readonly SupportedLanguage[],
  versions: Readonly<Record<string, string>>,
): string[] {
  const names = new Set(['tree-sitter']);
  for (const language of languages) {
    for (const name of GRAMMAR_PACKAGES[language]?.packages ?? []) names.add(name);
  }
  return [...names]
    .filter((name) => versions[name])
    .sort()
    .map((name) => `${name}@${versions[name]}`);
}

export function astParserLanguages(languages: readonly SupportedLanguage[]): SupportedLanguage[] {
  return [...new Set(languages.filter((language) => GRAMMAR_PACKAGES[language] !== undefined))].sort();
}

export function setupAstParsers(
  languages: readonly SupportedLanguage[],
  opts: { packageRoot?: string; runtime?: AstParserSetupRuntime } = {},
): AstParserSetupResult {
  const runtime = opts.runtime ?? DEFAULT_RUNTIME;
  const packageRoot = opts.packageRoot ?? installedPackageRoot();
  const supportedLanguages = astParserLanguages(languages);
  const availableBefore = supportedLanguages.filter((language) => runtime.probe(GRAMMAR_PACKAGES[language]!.ast));
  const missing = supportedLanguages.filter((language) => !availableBefore.includes(language));
  if (missing.length === 0) {
    return {
      supportedLanguages,
      availableBefore,
      installed: [],
      availableAfter: availableBefore,
      unavailable: [],
      attempted: false,
    };
  }

  const versions = optionalDependencyVersions(packageRoot);
  const packages = astParserPackagesForLanguages(missing, versions);
  const installation = runtime.install(packageRoot, packages);
  if (installation.ok) runtime.resetProbe();
  const availableAfter = supportedLanguages.filter((language) => runtime.probe(GRAMMAR_PACKAGES[language]!.ast));
  return {
    supportedLanguages,
    availableBefore,
    installed: installation.ok ? packages : [],
    availableAfter,
    unavailable: supportedLanguages.filter((language) => !availableAfter.includes(language)),
    attempted: true,
    ...(installation.error ? { error: installation.error } : {}),
  };
}

function installedPackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const packagePath = join(current, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown };
      if (parsed.name === 'scip-query') return current;
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('Unable to locate the installed scip-query package root.');
    current = parent;
  }
}

function optionalDependencyVersions(packageRoot: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
    optionalDependencies?: Record<string, string>;
  };
  return parsed.optionalDependencies ?? {};
}

const DEFAULT_RUNTIME: AstParserSetupRuntime = {
  probe: (language) => probeAstLanguageRuntime(language) === 'ast',
  resetProbe: resetAstRuntimeProbeCache,
  install: (packageRoot, packages) => {
    const result = spawnSync(
      process.env['npm_execpath'] ? process.execPath : 'npm',
      [
        ...(process.env['npm_execpath'] ? [process.env['npm_execpath']] : []),
        'install',
        '--no-save',
        '--no-package-lock',
        '--include=optional',
        ...packages,
      ],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    return result.status === 0
      ? { ok: true }
      : {
          ok: false,
          error: (result.stderr || result.stdout || result.error?.message || 'npm install failed').trim(),
        };
  },
};
