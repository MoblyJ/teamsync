// services/ — "external integrations" layer of the demo. Simulates an
// upstream API and normalizes its payloads into shared contract shapes.
// Pure functions, no network: deterministic and safe to run in CI.
import { apiOk } from "../../packages/contracts/contracts.mjs";

/** Raw payload shaped like an upstream provider's (deliberately awkward). */
export function fakeUpstreamRepoEvents() {
  return [
    { type: "PushEvent", actor: { login: "dev-services" }, created_at: "2026-10-27T09:00:00Z" },
    { type: "PullRequestEvent", actor: { login: "dev-frontend" }, created_at: "2026-10-27T09:05:00Z" },
  ];
}

/** Normalize into the demo's Task contract (role = services owns this mapping). */
export function normalizeEventsToTasks(raw) {
  return raw.map((e, i) => ({
    id: `evt-${i + 1}`,
    title: `${e.type} by ${e.actor.login}`,
    role: "services",
    done: false,
  }));
}

/** Service call envelope — validates before returning across the boundary. */
export function fetchRepoTasks() {
  return apiOk(normalizeEventsToTasks(fakeUpstreamRepoEvents()));
}
