export interface CompleteWritePort {
  writeFile(fd: number, bytes: Buffer, offset: number, length: number): number;
}

/**
 * Writes every byte or fails when the descriptor stops making valid forward
 * progress. Node permits short writes, so one successful write is not proof
 * that the complete record reached the descriptor.
 */
export function writeFileCompletely(fd: number, bytes: Buffer, runtime: CompleteWritePort, subject: string): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = runtime.writeFile(fd, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
      throw new Error(`${subject} write did not make valid forward progress`);
    }
    offset += written;
  }
}

/**
 * Classifies only the Windows errors that mean Node cannot open or flush a
 * directory handle. Other failures retain their operational meaning.
 */
export function isDirectorySyncUnsupported(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EBADF' || code === 'EINVAL' || code === 'EISDIR' || code === 'EPERM';
}
