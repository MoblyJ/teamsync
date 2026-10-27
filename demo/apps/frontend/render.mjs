// apps/frontend/ — demo UI logic. Deliberately split so the data-rendering
// half is pure and testable without a browser; app.mjs is the browser half.
import { apiError } from "../../packages/contracts/contracts.mjs";

/** Render tasks (validated against the contract) to simple HTML list items. */
export function tasksToHtml(tasks) {
  if (!Array.isArray(tasks) || tasks.some((t) => typeof t !== "object" || t === null || !("title" in t))) {
    throw new TypeError("payload violates the Task contract");
  }
  return `<ul>\n${tasks.map((t) => `  <li data-role="${t.role}">${t.done ? "✔" : "•"} ${escapeHtml(t.title)}</li>`).join("\n")}\n</ul>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fetch + validate — the frontend's only supported way to consume the API. */
export async function loadTasks(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tasks`);
  if (!res.ok) return apiError(`API returned ${res.status}`);
  const payload = await res.json();
  if (payload.ok !== true) return apiError(payload.error ?? "API error");
  try {
    return { ok: true, data: tasksToHtml(payload.data) };
  } catch (err) {
    return apiError((err).message);
  }
}
