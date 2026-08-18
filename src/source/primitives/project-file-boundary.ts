/**
 * Source-facing facade for the host filesystem project-file proof.
 *
 * Query, analysis, and augmentation modules depend on the source boundary;
 * this facade keeps the platform mechanism behind that architectural owner.
 */
export {
  DEFAULT_PROJECT_SOURCE_LIMIT_BYTES,
  InputTooLargeError,
  isMissingProjectFileError,
  projectFileExists,
  probeProjectFileBytes,
  readProjectFile,
  readProjectFileText,
  resolveProjectFile,
  type ProjectFileReadOptions,
  type ProjectFileByteProbe,
  type ProjectFileByteProbeOptions,
  type ResolvedProjectFile,
} from '../../platform/project-files.js';
export {
  normalizeSafeProjectRelativePath,
  UnsafeProjectPathError,
  type ProjectFileFailure,
} from '../../domain/path-normalization.js';
