import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SupportedLanguage } from '../types.js';

interface LanguageMarker {
  language: SupportedLanguage;
  files: string[];
}

/**
 * Marker files that indicate a language is present in a project.
 * Ordered roughly by specificity — more specific markers first.
 */
const LANGUAGE_MARKERS: LanguageMarker[] = [
  { language: 'typescript', files: ['tsconfig.json', 'tsconfig.base.json'] },
  { language: 'rust', files: ['Cargo.toml'] },
  { language: 'go', files: ['go.mod'] },
  { language: 'java', files: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
  { language: 'kotlin', files: ['build.gradle.kts'] },
  { language: 'scala', files: ['build.sbt'] },
  { language: 'python', files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile'] },
  { language: 'ruby', files: ['Gemfile'] },
  { language: 'csharp', files: ['*.csproj', '*.sln'] },
  { language: 'dart', files: ['pubspec.yaml'] },
  { language: 'php', files: ['composer.json'] },
  { language: 'javascript', files: ['package.json'] }, // Last — very common, low specificity
];

/**
 * Detect which languages are present in a project directory
 * by checking for marker files.
 */
export function detectLanguages(projectRoot: string): SupportedLanguage[] {
  const detected: SupportedLanguage[] = [];

  for (const marker of LANGUAGE_MARKERS) {
    for (const file of marker.files) {
      if (file.includes('*')) {
        // Glob patterns — skip for now, basic detection only
        continue;
      }
      if (existsSync(join(projectRoot, file))) {
        if (!detected.includes(marker.language)) {
          detected.push(marker.language);
        }
        break;
      }
    }
  }

  // If we found TypeScript, don't also report JavaScript (it's implied)
  if (detected.includes('typescript')) {
    const jsIdx = detected.indexOf('javascript');
    if (jsIdx !== -1) detected.splice(jsIdx, 1);
  }

  return detected;
}
