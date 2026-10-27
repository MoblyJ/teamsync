// Cross-component integration test for the demo app: services → backend →
// frontend boundaries proven against the shared contract, over a REAL http
// server on a real port. No component is mocked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

const DEMO = path.resolve(import.meta.dirname, "..", "..", "demo");

// Import the real demo modules (ESM .mjs — no build step, no mocks).
const contracts = await import(path.join(DEMO, "packages", "contracts", "contracts.mjs"));
const services = await import(path.join(DEMO, "services", "integrations", "github-events.mjs"));
const frontend = await import(path.join(DEMO, "apps", "frontend", "render.mjs"));

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  const { createApp } = await import(path.join(DEMO, "apps", "backend", "server.mjs"));
  server = (createApp as () => ReturnType<typeof createServer>)();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("demo: cross-component compatibility through the shared contract", () => {
  it("services layer normalizes upstream payloads into valid contract shapes", () => {
    const result = services.fetchRepoTasks();
    expect(result.ok).toBe(true);
    for (const task of result.data as unknown[]) {
      expect(contracts.isValidTask(task)).toBe(true);
    }
  });

  it("backend /api/health serves the contract envelope", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.cliVersion).toBe(
      JSON.parse(readFileSync(path.resolve(DEMO, "..", "package.json"), "utf8")).version,
    );
  });

  it("backend GET /api/tasks returns contract-valid tasks composed from services", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const task of body.data) expect(contracts.isValidTask(task)).toBe(true);
  });

  it("backend rejects contract-violating POSTs with 422 (boundary enforcement)", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t9", title: "bad", role: "not-a-role", done: false }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("backend accepts contract-valid POSTs and includes them in GET", async () => {
    const task = { id: "t1", title: "Wire the ingest", role: "backend", done: false };
    const post = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task),
    });
    expect(post.status).toBe(201);

    const list = await (await fetch(`${baseUrl}/api/tasks`)).json();
    expect(list.data.some((t: { id: string }) => t.id === "t1")).toBe(true);
  });

  it("frontend rendering consumes the real API and validates the payload", async () => {
    const result = await frontend.loadTasks(baseUrl);
    expect(result.ok).toBe(true);
    expect(result.data).toContain("<ul>");
    expect(result.data).toContain("Wire the ingest");
  });

  it("frontend rejects mismatched payloads instead of rendering them", () => {
    expect(() => frontend.tasksToHtml([{ nope: true }])).toThrow(/contract/i);
  });
});
