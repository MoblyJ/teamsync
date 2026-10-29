// Integration tests — the real HTTP server (node:http on port 0) exercised
// with real fetch calls: REST flows, admin gating, SSE stream, dashboard
// page, GitHub-status route mocked at the gh boundary (fake gh shim).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { RegistryStore } from "../../src/server/store.js";
import { createApp } from "../../src/server/http.js";
import { makeFakeGh, type FakeGh } from "../helpers/fake-gh.js";

let server: http.Server;
let baseUrl: string;
let stateFile: string;
let root: string;
let fakeGh: FakeGh;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "teamsync-server-"));
  stateFile = path.join(root, "state.json");
  fakeGh = await makeFakeGh();
  const store = new RegistryStore(stateFile);
  await store.load();
  server = createApp(store, { port: 0, host: "127.0.0.1", ghPath: fakeGh.ghPath });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fakeGh.cleanup();
  await rm(root, { recursive: true, force: true });
});

async function call(
  pathName: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

describe("team server REST flow", () => {
  it("health responds; no page/UI routes exist", async () => {
    const health = await call("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    // The dashboard UI was removed: the root must not serve HTML anymore.
    const root = await call("/");
    expect(root.status).toBe(404);
    expect(JSON.stringify(root.body)).not.toMatch(/<html|TeamSync —/);
  });

  it("admin creates a team; join code + admin token returned exactly once", async () => {
    const res = await call("/api/teams", {
      method: "POST",
      body: { name: "Hackers", adminLogin: "leo" },
    });
    expect(res.status).toBe(201);
    expect(res.body.team.admin).toBe("leo");
    expect(res.body.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(typeof res.body.adminToken).toBe("string");

    // Public view never leaks secrets.
    const pub = await call("/api/teams");
    expect(JSON.stringify(pub.body)).not.toContain(res.body.joinCode);
  });

  it("membership join: wrong code 403, right code 200, duplicate join idempotent", async () => {
    const created = await call("/api/teams", { method: "POST", body: { name: "Builders", adminLogin: "ivy" } });
    const wrong = await call("/api/teams/builders/join", {
      method: "POST",
      body: { login: "mia", role: "qa", joinCode: "XXXXXX" },
    });
    expect(wrong.status).toBe(403);

    const right = await call("/api/teams/builders/join", {
      method: "POST",
      body: { login: "mia", role: "qa", joinCode: created.body.joinCode },
    });
    expect(right.status).toBe(200);
    expect(right.body.team.memberCount).toBe(2);

    const again = await call("/api/teams/builders/join", {
      method: "POST",
      body: { login: "mia", role: "frontend", joinCode: created.body.joinCode },
    });
    expect(again.body.team.memberCount).toBe(2);
    expect(again.body.team.members.find((m: any) => m.login === "mia").role).toBe("frontend");
  });

  it("admin actions are gated by the admin token", async () => {
    const created = await call("/api/teams", { method: "POST", body: { name: "Admins", adminLogin: "sam" } });
    await call("/api/teams/admins/join", {
      method: "POST",
      body: { login: "mia", role: "qa", joinCode: created.body.joinCode },
    });

    const noToken = await call("/api/teams/admins/remove-member", {
      method: "POST",
      body: { login: "mia", adminToken: "nope" },
    });
    expect(noToken.status).toBe(403);

    const withToken = await call("/api/teams/admins/remove-member", {
      method: "POST",
      body: { login: "mia", adminToken: created.body.adminToken },
    });
    expect(withToken.status).toBe(200);
    expect(withToken.body.team.memberCount).toBe(1);
  });

  it("heartbeat updates lastSeen; unknown member 404", async () => {
    const created = await call("/api/teams", { method: "POST", body: { name: "Pulse", adminLogin: "leo" } });
    const beat = await call("/api/teams/pulse/heartbeat", { method: "POST", body: { login: "leo" } });
    expect(beat.status).toBe(200);
    expect(beat.body.team.members[0].lastSeen).toBeTruthy();

    const ghost = await call("/api/teams/pulse/heartbeat", { method: "POST", body: { login: "nobody" } });
    expect(ghost.status).toBe(404);
  });

  it("state persists to disk (restart-safe)", async () => {
    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    expect(Object.keys(raw.teams).length).toBeGreaterThanOrEqual(3);
    expect(raw.teams.admins.admin).toBe("sam");
  });

  it("errors are structured JSON with hints", async () => {
    const res = await call("/api/teams/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not-found");
  });

  it("SSE stream pushes registry events", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Trigger a mutation; the stream should deliver an event.
    const firstChunk = (async () => {
      const reader = res.body!.getReader();
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SSE timeout")), 4000));
      let received = "";
      try {
        while (!received.includes("teams.changed")) {
          const r = await Promise.race([reader.read(), timeout]);
          received += new TextDecoder().decode(r.value ?? new Uint8Array());
        }
      } finally {
        controller.abort();
      }
      return received;
    })();
    await call("/api/teams", { method: "POST", body: { name: "Streamy", adminLogin: "leo" } });
    const received = await firstChunk;
    expect(received).toContain("teams.changed");
  });

  it("GitHub PR-status route reuses core + gh adapter (MOCK GitHub)", async () => {
    const res = await call("/api/repos/example/demo/status");
    expect(res.status).toBe(200);
    expect(res.body.repository).toBe("example/demo");
    expect(Array.isArray(res.body.prs)).toBe(true);
  });
});

describe("team server discovery beacons (UDP loopback)", () => {
  it("listener receives a directly-sent beacon", async () => {
    const dgram = await import("node:dgram");
    const { discoverServers } = await import("../../src/server/discovery.js");
    const listen = discoverServers(1200);
    // Wait for the listener to bind, then send a beacon to loopback.
    await new Promise((r) => setTimeout(r, 300));
    const sender = dgram.createSocket("udp4");
    const payload = Buffer.from(JSON.stringify({ type: "teamsync-server", name: "loop-host", port: 4700, teams: 2 }));
    await new Promise<void>((resolve) => sender.send(payload, 0, payload.length, 41733, "127.0.0.1", resolve));
    sender.close();
    const found = await listen;
    expect(found.some((f) => f.name === "loop-host" && f.address === "127.0.0.1")).toBe(true);
  });
});
