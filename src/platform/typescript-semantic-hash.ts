import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';

const require = createRequire(import.meta.url);
const TYPESCRIPT_SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?)$/iu;
const JSX_SOURCE_PATTERN = /\.[jt]sx$/iu;
const PACKAGE_JSON_PATTERN = /(?:^|\/)package\.json$/iu;
let loadedTypeScript: typeof TypeScript | null | undefined;
const recoveredPackageHashes = new Map<string, string | undefined>();

/**
 * Identifies the TypeScript tokens and meaningful line boundaries in one
 * source file. Runs of spaces and repeated blank lines are excluded, while
 * comments, literals, JSX text, and the first newline between tokens remain.
 */
export function typeScriptSemanticHash(relativePath: string, source: Buffer | string): string | undefined {
  if (!supportsTypeScriptSemanticHash(relativePath)) return undefined;
  const ts = typeScriptCompiler();
  if (!ts) return undefined;

  try {
    const text = typeof source === 'string' ? source : source.toString('utf8');
    const languageVariant = JSX_SOURCE_PATTERN.test(relativePath)
      ? ts.LanguageVariant.JSX
      : ts.LanguageVariant.Standard;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, languageVariant, text);
    const hash = createHash('sha256').update(`typescript-semantic-v1\0${languageVariant}\0`);
    let emittedToken = false;
    let pendingLineBreak = false;

    for (;;) {
      const token = scanner.scan();
      if (token === ts.SyntaxKind.EndOfFileToken) break;
      if (token === ts.SyntaxKind.WhitespaceTrivia) continue;
      if (token === ts.SyntaxKind.NewLineTrivia) {
        if (emittedToken) pendingLineBreak = true;
        continue;
      }
      if (pendingLineBreak) hash.update('line-break\0');
      const tokenText = scanner.getTokenText();
      hash
        .update(`${token}\0${Buffer.byteLength(tokenText)}\0`)
        .update(tokenText)
        .update('\0');
      emittedToken = true;
      pendingLineBreak = false;
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

// scip-query: ignore-wrapper — shared eligibility rule keeps direct hashing and project fingerprinting in agreement.
export function supportsTypeScriptSemanticHash(relativePath: string): boolean {
  return TYPESCRIPT_SOURCE_PATTERN.test(relativePath);
}

/**
 * Identifies the parts of package.json that can affect TypeScript project or
 * module resolution. Script commands are runtime tooling, so changing only a
 * script must not invalidate the compiler shard.
 */
// scip-query: ignore-wrapper — package semantic identity is a named cache contract, not incidental hashing indirection.
export function typeScriptPackageSemanticHash(relativePath: string, source: Buffer | string): string | undefined {
  if (!PACKAGE_JSON_PATTERN.test(relativePath)) return undefined;
  try {
    const parsed = JSON.parse(typeof source === 'string' ? source : source.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const { scripts: _scripts, ...compilerRelevant } = parsed as Record<string, unknown>;
    return createHash('sha256')
      .update('typescript-package-json-v1\0')
      .update(stableJson(compilerRelevant))
      .digest('hex');
  } catch {
    return undefined;
  }
}

// scip-query: ignore-wrapper — shared eligibility rule keeps live hashing and historical recovery in agreement.
export function supportsTypeScriptPackageSemanticHash(relativePath: string): boolean {
  return PACKAGE_JSON_PATTERN.test(relativePath);
}

/**
 * Backfills semantic package identity for indexes written before it was
 * recorded. Git blobs are immutable historical file contents, so a matching
 * byte hash proves which prior package.json produced the accepted snapshot.
 */
export function recoverTypeScriptPackageSemanticHash(
  projectRoot: string,
  relativePath: string,
  expectedByteHash: string,
): string | undefined {
  if (!supportsTypeScriptPackageSemanticHash(relativePath) || !/^[a-f0-9]{64}$/u.test(expectedByteHash)) {
    return undefined;
  }
  const cacheKey = `${projectRoot}\0${relativePath}\0${expectedByteHash}`;
  if (recoveredPackageHashes.has(cacheKey)) return recoveredPackageHashes.get(cacheKey);

  let recovered: string | undefined;
  try {
    const commits = execFileSync(
      'git',
      ['-C', projectRoot, 'log', '--all', '--format=%H', '--max-count=64', '--', relativePath],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5_000 },
    )
      .split(/\r?\n/u)
      .filter(Boolean);
    for (const commit of commits) {
      const contents = execFileSync('git', ['-C', projectRoot, 'show', `${commit}:${relativePath}`], {
        encoding: null,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5_000,
      });
      if (createHash('sha256').update(contents).digest('hex') !== expectedByteHash) continue;
      recovered = typeScriptPackageSemanticHash(relativePath, contents);
      break;
    }
  } catch {
    recovered = undefined;
  }
  recoveredPackageHashes.set(cacheKey, recovered);
  return recovered;
}

function typeScriptCompiler(): typeof TypeScript | null {
  if (loadedTypeScript !== undefined) return loadedTypeScript;
  try {
    loadedTypeScript = require('typescript') as typeof TypeScript;
  } catch {
    loadedTypeScript = null;
  }
  return loadedTypeScript;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
