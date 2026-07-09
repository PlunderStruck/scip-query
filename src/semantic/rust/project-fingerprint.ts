import { createHash } from 'node:crypto';
import { fingerprintProjectFiles } from '../../reindex/project-files.js';

const RUST_ANALYZER_INPUT_BASENAMES = new Set([
  'Cargo.lock',
  'Cargo.toml',
  'rust-project.json',
  'rust-toolchain',
  'rust-toolchain.toml',
]);

export function rustAnalyzerProjectFingerprint(projectRoot: string): string {
  const files = fingerprintProjectFiles(projectRoot, { includePath: isRustAnalyzerProjectInput });
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function isRustAnalyzerProjectInput(relativePath: string): boolean {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const basename = normalizedPath.split('/').at(-1) ?? normalizedPath;
  if (normalizedPath.endsWith('.rs') || RUST_ANALYZER_INPUT_BASENAMES.has(basename)) return true;
  return (
    normalizedPath === '.cargo/config' ||
    normalizedPath === '.cargo/config.toml' ||
    normalizedPath.endsWith('/.cargo/config') ||
    normalizedPath.endsWith('/.cargo/config.toml')
  );
}
