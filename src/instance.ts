const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function normalizeInstanceName(instanceName?: string): string {
  if (instanceName === undefined) {
    return "default";
  }

  const normalized = instanceName.trim();
  if (!normalized) {
    throw new Error("Invalid instance name");
  }

  if (!INSTANCE_NAME_PATTERN.test(normalized)) {
    throw new Error("Invalid instance name");
  }

  return normalized;
}
