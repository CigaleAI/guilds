export class MissingSecretError extends Error {
  name = "MissingSecretError";
  secretName: string;

  constructor(secretName: string) {
    super(`secret ${secretName} is not set`);
    this.secretName = secretName;
  }
}

export function resolveSecrets(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new MissingSecretError(name);
    }
    values[name] = value;
  }
  return values;
}

export function redact(text: string, secrets: Record<string, string>): string {
  const items = Object.entries(secrets).sort((left, right) => right[1].length - left[1].length);
  let out = text;
  for (const [name, value] of items) {
    if (value) {
      out = out.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return out;
}
