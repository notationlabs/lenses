export function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : undefined;
    try {
      const details = JSON.stringify(error);
      if (message && details !== "{}" && details !== JSON.stringify({ message })) {
        return `${message} (${details})`;
      }
      if (message) return message;
      if (details && details !== "{}") return details;
    } catch {
      if (message) return message;
    }
    return "non-serializable object error";
  }
  return String(error);
}
