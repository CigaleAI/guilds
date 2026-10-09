const NAME_SAFE = /[^A-Za-z0-9_-]+/g;

export function namespacedName(prefix: string, remoteName: string): string {
  const safe = remoteName.replace(NAME_SAFE, "_").replace(/^_+|_+$/g, "") || "tool";
  return `${prefix}_${safe}`;
}
