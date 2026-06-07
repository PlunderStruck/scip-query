import type { ProjectConfig, SupportedLanguage } from '../domain/types.js';
import { detectLanguages } from '../reindex/detect.js';
import { getIndexerConfig } from '../reindex/indexers.js';
import { getIndexerDependencyStatus } from '../reindex/install.js';
import { getTypeScriptSemanticStatus } from '../semantic/typescript/status.js';

export interface LanguageReadiness {
  language: SupportedLanguage;
  binaryLabel: string;
  installed: boolean;
  runnable: boolean;
  resolvedBinary?: string;
  note?: string;
  installUrl?: string;
}

export interface SemanticReadiness {
  language: 'typescript';
  available: boolean;
  dependencyAvailable: boolean;
  tsconfigPath?: string;
  tsconfigPaths?: string[];
  reason?: string;
}

export interface ProjectReadiness {
  languages: SupportedLanguage[];
  indexers: LanguageReadiness[];
  semantic?: SemanticReadiness;
}

export function getProjectReadiness(projectRoot: string, config: ProjectConfig): ProjectReadiness {
  const languages = config.languages ?? detectLanguages(projectRoot);
  const indexers = languages.map((language) => {
    const status = getIndexerDependencyStatus(getIndexerConfig(language), projectRoot);
    return {
      ...status,
      language,
      resolvedBinary: status.resolvedBinary ?? undefined,
    };
  });
  const semantic = languages.includes('typescript')
    ? {
      language: 'typescript' as const,
      ...getTypeScriptSemanticStatus(projectRoot, config.semantic?.typescript?.tsconfigs),
    }
    : undefined;

  return { languages, indexers, semantic };
}
