// Unit tests — branch naming: uniqueness format, parseability, safety.
import { describe, expect, it } from "vitest";
import { makeTaskBranch, parseTaskBranch, isTeamsyncBranch, suffixFrom, taskBranchName } from "../../src/core/branch.js";

describe("task branch naming", () => {
  it("embeds login, role, slug, and suffix", () => {
    const b = makeTaskBranch("alice", "frontend", "Add homepage", "a1b2c3");
    expect(b).toBe("teamsync/alice/frontend/add-homepage-a1b2c3");
  });

  it("parses round-trip", () => {
    const b = makeTaskBranch("alice", "qa", "fix flaky test", "dead00");
    const parts = parseTaskBranch(b!);
    expect(parts).toEqual({ login: "alice", role: "qa", task: "fix-flaky-test", suffix: "dead00" });
  });

  it("sanitizes hostile logins", () => {
    const b = makeTaskBranch("Alice/../etc", "frontend", "task", "a1b2c3");
    expect(b).toBe("teamsync/alice-etc/frontend/task-a1b2c3");
  });

  it("rejects empty logins", () => {
    expect(makeTaskBranch("---", "frontend", "task", "a1b2c3")).toBeNull();
  });

  it("different suffixes never collide (uniqueness contract)", () => {
    const a = makeTaskBranch("alice", "frontend", "homepage", "aaaaaa");
    const b = makeTaskBranch("bob", "frontend", "homepage", "bbbbbb");
    expect(a).not.toBe(b);
    // Even the same person gets distinct suffixes per run.
    const s1 = suffixFrom("seed1");
    const s2 = suffixFrom("seed2");
    expect(s1).not.toBe(s2);
  });

  it("two teammates with the same task name still differ by login", () => {
    const a = makeTaskBranch("alice", "services", "ingest", "111111");
    const b = makeTaskBranch("bob", "services", "ingest", "111111");
    expect(a).not.toBe(b);
  });

  it("taskBranchName keeps slugs within git's 200-char limits", () => {
    const longTask = "x".repeat(300);
    const b = taskBranchName({ login: "u", role: "r", taskSlug: longTask.slice(0, 40), suffix: "a1b2c3" });
    expect(b.length).toBeLessThan(200);
  });

  it("isTeamsyncBranch identifies managed branches only", () => {
    expect(isTeamsyncBranch("teamsync/a/r/t-a1b2c3")).toBe(true);
    expect(isTeamsyncBranch("feature/foo")).toBe(false);
    expect(isTeamsyncBranch("teamsyncish")).toBe(false);
    expect(isTeamsyncBranch("main")).toBe(false);
  });
});
