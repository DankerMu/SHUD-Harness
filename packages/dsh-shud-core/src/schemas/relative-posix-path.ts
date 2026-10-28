export function isRelativePosixPath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\0") && !/(?:^|\/)\.\.(?:\/|$)/u.test(path);
}
