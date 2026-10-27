// Shared cross-role contracts — edit deliberately and coordinate (see README).
// Keep this framework-free so services, backend, and frontend can all use it.

/** A task being tracked by the team demo. */
export interface Task {
  id: string;
  title: string;
  /** Which role owns the task: services | backend | frontend | qa. */
  role: string;
  done: boolean;
}

/** Envelope used by demo API responses. */
export interface ApiResponse<T> {
  ok: boolean;
  data: T;
  error?: string;
}

/** Minimal runtime validator — proves payloads match the contract. */
export function isValidTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.role === "string" &&
    typeof v.done === "boolean"
  );
}
