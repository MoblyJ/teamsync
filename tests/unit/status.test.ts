// Unit tests — team status model with the FakeGitHubAdapter (MOCK boundary).
// Covers role attribution from branch names, ordering, and JSON shape.
import { describe, expect, it } from "vitest";
import { buildTeamStatus } from "../../src/core/status.js";
import { FakeGitHubAdapter } from "../helpers/fake-adapter.js";
import { parseConfig } from "../../src/core/config.js";
import type { PullRequest } from "../../src/core/github.js";

const config = parseConfig({
  version: 1,
  repository: "example/demo",
  defaultBranch: "main",
  roles: {
    services: { paths: ["services/**"] },
    backend: { paths: ["apps/backend/**"] },
    frontend: { paths: ["apps/frontend/**"] },
    qa: { paths: ["tests/**"] },
  },
  checks: { required: ["integration"] },
});

function pr(overrides: Partial<PullRequest>): PullRequest {
  return {
    nodeId: "PR_x",
    number: 1,
    url: "https://github.com/example/demo/pull/1",
    title: "t",
    state: "open",
    draft: false,
    headRefName: "teamsync/alice/frontend/task-a1b2c3",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseRefName: "main",
    baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    mergeable: true,
    mergeStateStatus: "CLEAN",
    autoMerge: null,
    reviewDecision: null,
    authorLogin: "alice",
    ...overrides,
  };
}

describe("buildTeamStatus (MOCK adapter)", () => {
  it("attributes roles and authors from branch names", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.prs = [
      pr({ number: 2, headRefName: "teamsync/bob/backend/api-x-dead00", authorLogin: "bob", title: "API X" }),
      pr({ number: 1, headRefName: "teamsync/alice/frontend/homepage-a1b2c3", authorLogin: "alice" }),
    ];
    const status = await buildTeamStatus(adapter, config, "alice", { viewerRole: "frontend" });
    expect(status.repository).toBe("example/demo");
    expect(status.viewer).toEqual({ login: "alice", role: "frontend" });
    expect(status.prs.map((p) => p.role)).toEqual(["frontend", "backend"]); // mine first
    expect(status.prs[0]!.mine).toBe(true);
    expect(status.prs[0]!.task).toBe("homepage");
  });

  it("excludes non-teamsync PRs unless allPRs (requirement 7: no unrelated enrollment)", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.prs = [
      pr({ number: 5, headRefName: "dependabot/npm_and_yarn/lodash-4.17.21", authorLogin: "dependabot[bot]" }),
      pr({ number: 6, headRefName: "teamsync/carl/services/ingest-112233", authorLogin: "carl" }),
    ];
    const filtered = await buildTeamStatus(adapter, config, "alice");
    expect(filtered.prs.map((p) => p.number)).toEqual([6]);

    const all = await buildTeamStatus(adapter, config, "alice", { allPRs: true });
    expect(all.prs).toHaveLength(2);
  });

  it("surfaces conflict and failure states with blockers", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.prs = [
      pr({ number: 3, authorLogin: "bob", mergeable: false, mergeStateStatus: "DIRTY" }),
    ];
    const status = await buildTeamStatus(adapter, config, "alice");
    expect(status.prs[0]!.state).toBe("conflict");
    expect(status.prs[0]!.blockers.length).toBeGreaterThan(0);
  });

  it("sorts severity: conflicts before pending before auto-merge-set", async () => {
    const adapter = new FakeGitHubAdapter();
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    adapter.prs = [
      pr({ number: 10, authorLogin: "dave", autoMerge: { enabledBy: "dave", mergeMethod: "squash" } }),
      pr({
        number: 11,
        authorLogin: "bob",
        mergeStateStatus: "BLOCKED",
        mergeable: null,
        // All visible checks pass, yet GitHub still reports BLOCKED — a
        // protection mismatch the CLI must surface, not paper over.
      }),
      pr({ number: 12, authorLogin: "carl", mergeable: false, mergeStateStatus: "DIRTY" }),
    ];
    adapter.checksByHead.set(head, [{ name: "integration", source: "actions", state: "success", headSha: head }]);
    const status = await buildTeamStatus(adapter, config, "alice");
    expect(status.prs.map((p) => p.state)).toEqual(["conflict", "blocked", "auto-merge-requested"]);
  });

  it("includes the visibility note about unpushed teammate edits", async () => {
    const status = await buildTeamStatus(new FakeGitHubAdapter(), config, "alice");
    expect(status.notes.join(" ")).toMatch(/unpushed/i);
  });

  it("reports required check states per PR, staleness flagged", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.prs = [pr({ headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })];
    adapter.checksByHead.set("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [
      { name: "integration", source: "actions", state: "success", headSha: "1111111111111111111111111111111111111111" },
    ]);
    const status = await buildTeamStatus(adapter, config, "alice");
    const report = status.prs[0]!.checks.find((c) => c.name === "integration")!;
    expect(report.stale).toBe(true);
    expect(status.prs[0]!.state).toBe("checks-pending");
  });
});
