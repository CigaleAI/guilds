export const MEMORY_DIR = "history-archive";
export const LEGACY_MEMORY_DIR = "memory-archive";

function archiveDirNames(): [string, string] {
  return [MEMORY_DIR, LEGACY_MEMORY_DIR];
}

function isExactArchiveDir(posix: string, name: string): boolean {
  return posix === name || posix === `${name}/`;
}

function isNestedUnderArchiveDir(posix: string, name: string): boolean {
  return posix.endsWith(`/${name}`) || posix.endsWith(`/${name}/`) || posix.includes(`/${name}/`);
}

function posixEqualsOrInsideDir(posix: string, name: string): boolean {
  return isExactArchiveDir(posix, name) || isNestedUnderArchiveDir(posix, name);
}

function isDirOrChild(posix: string, dir: string): boolean {
  return posix === dir || posix.startsWith(`${dir}/`);
}

export function omitMemoryArchive(paths: string[]): string[] {
  const items: string[] = [];
  for (const path of paths) {
    const posix = path.replaceAll("\\", "/");
    if (archiveDirNames().some((name) => posixEqualsOrInsideDir(posix, name))) {
      continue;
    }
    items.push(path);
  }
  return items;
}

export function isRelativeMemoryArchivePath(posix: string): boolean {
  return archiveDirNames().some(
    (name) => isDirOrChild(posix, name) || isDirOrChild(posix, `notes/${name}`),
  );
}
