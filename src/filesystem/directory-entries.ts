import { readdirSync, type Dirent } from 'node:fs';

/** Best-effort directory enumeration for repository and project discovery. */
export function readableDirectoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}
