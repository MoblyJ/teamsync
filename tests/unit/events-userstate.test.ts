// Unit tests — structured events + user state storage.
import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryEventSink, JsonlFileEventSink } from "../../src/core/events.js";
import { loadUserState, saveMembership, clearMembership, userStateDir, findMembership } from "../../src/core/userstate.js";

describe("events", () => {
  it("MemoryEventSink records ordered events", () => {
    const sink = new MemoryEventSink();
    sink.emit({ ts: "t1", type: "command.start" });
    sink.emit({ ts: "t2", type: "git.op", data: { op: "push" } });
    expect(sink.events.map((e) => e.type)).toEqual(["command.start", "git.op"]);
  });

  it("JsonlFileEventSink writes valid JSONL (dashboard seam)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "teamsync-ev-"));
    const file = path.join(dir, "events.jsonl");
    const sink = new JsonlFileEventSink(file, "submit");
    sink.emit({ ts: "t1", type: "pr.created", data: { pr: 1 } });
    sink.emit({ ts: "t2", type: "warning" });
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.type).toBe("pr.created");
    expect(first.command).toBe("submit");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("user state", () => {
  it("stores and clears memberships in TEAMSYNC_HOME (never in the repo)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "teamsync-home-"));
    const env = { TEAMSYNC_HOME: dir };
    expect(userStateDir(env)).toBe(dir);

    await saveMembership(
      { repository: "example/demo", role: "frontend", clonePath: "/tmp/demo", joinedAt: "2026-10-27T00:00:00Z" },
      env,
    );
    const state = await loadUserState(env);
    expect(findMembership(state, "example/demo", "/tmp/demo")?.role).toBe("frontend");

    // Regression: two clones of the SAME repo must coexist (shared machines,
    // WSL + Windows side by side). Keyed by repo AND clone path.
    await saveMembership(
      { repository: "example/demo", role: "backend", clonePath: "/tmp/demo-wsl", joinedAt: "2026-10-27T00:00:01Z" },
      env,
    );
    let two = await loadUserState(env);
    expect(Object.keys(two.memberships)).toHaveLength(2);
    expect(findMembership(two, "example/demo", "/tmp/demo")?.role).toBe("frontend");
    expect(findMembership(two, "example/demo", "/tmp/demo-wsl")?.role).toBe("backend");
    expect(findMembership(two, "example/demo", "/tmp/unknown")).toBeNull();

    await clearMembership("example/demo", env);
    expect(Object.keys((await loadUserState(env)).memberships)).toHaveLength(0);

    // Only one state file lives there — no token-shaped content anywhere.
    const raw = await readFile(path.join(dir, "state.json"), "utf8");
    expect(raw).not.toMatch(/gh[posur]_/);
    await rm(dir, { recursive: true, force: true });
  });

  it("tolerates corrupt state files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "teamsync-home-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "state.json"), "{not json", "utf8");
    expect(await loadUserState({ TEAMSYNC_HOME: dir })).toEqual({ version: 1, memberships: {} });
    await rm(dir, { recursive: true, force: true });
  });
});
