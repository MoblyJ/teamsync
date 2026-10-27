// Shared cross-role contract for the demo (mirrors templates/contracts.ts).
// This is the seam between services → backend → frontend. Changing a shape
// here is a coordinated team event; CI's integration gate proves
// compatibility across components on every PR.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROLES = ["services", "backend", "frontend", "qa"];

/** @typedef {{ id: string, title: string, role: string, done: boolean }} Task */

/** Runtime validator — proves any payload crossing a boundary matches the contract. */
export function isValidTask(value) {
  return (
    typeof value === "object" && value !== null &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.role === "string" &&
    ROLES.includes(value.role) &&
    typeof value.done === "boolean"
  );
}

/** @returns {{ ok: boolean, data: unknown, error?: string }} */
export function apiOk(data) {
  return { ok: true, data };
}

export function apiError(message) {
  return { ok: false, data: null, error: message };
}

/** Demo metadata from the CLI's own package.json — proves the envelope too. */
export function cliVersion() {
  const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf8")).version;
}
