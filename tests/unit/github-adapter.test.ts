// Adapter tests: GhCliAdapter driven by a REAL fake `gh` executable on disk
// (subprocess boundary exercised for true), with argv logging. Results are
// MOCK data by construction; assertions cover argument arrays, JSON mapping,
// and error translation. Windows-safe via the .cmd shim + needsShell path.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { GhCliAdapter, mapGhError, ghApi } from "../../src/core/github.js";
import { GhNotInstalledError } from "../../src/core/github.js";
import { TeamsyncError, ExitCode } from "../../src/core/errors.js";
import { makeFakeGh, type FakeGh, defaultState } from "../helpers/fake-gh.js";

let fake: FakeGh;
let adapter: GhCliAdapter;

beforeEach(async () => {
  fake = await makeFakeGh();
  adapter = new GhCliAdapter({ ghPath: fake.ghPath });
});

afterEach(async () => {
  await fake.cleanup();
});

describe("GhCliAdapter (via fake gh executable — MOCK GitHub)", () => {
  it("whoAmI parses the login", async () => {
    const me = await adapter.whoAmI();
    expect(me.login).toBe("alice");
    const log = await fake.readLog();
    expect(log[0]!.argv[0]).toBe("api");
    expect(log[0]!.argv[1]).toBe("user");
  });

  it("getRepo maps capability fields (MOCK repo)", async () => {
    const info = await adapter.getRepo("example", "demo");
    expect(info.nameWithOwner).toBe("example/demo");
    expect(info.defaultBranch).toBe("main");
    expect(info.allowAutoMerge).toBe(true);
    expect(info.viewerPermission).toBe("write");
  });

  it("viewer_permission absent → falls back to permissions.push", async () => {
    const state = defaultState();
    (state.repo as Record<string, unknown>) = {
      ...(state.repo as Record<string, unknown>),
      viewer_permission: undefined,
      permissions: { push: true },
    };
    await fake.setState(state);
    const info = await adapter.getRepo("example", "demo");
    expect(info.viewerPermission).toBe("write");
  });

  it("listOpenPRs maps mergeable_state to the enum", async () => {
    const state = defaultState();
    state.prs = [
      {
        node_id: "PR_1",
        number: 1,
        html_url: "https://github.com/example/demo/pull/1",
        title: "Add homepage",
        state: "open",
        user: { login: "alice" },
        head: { ref: "teamsync/alice/frontend/homepage-a1b2c3", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        base: { ref: "main", sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        mergeable: true,
        mergeable_state: "clean",
        auto_merge: { enabled_by: { login: "alice" }, merge_method: "squash" },
      },
    ];
    await fake.setState(state);
    const prs = await adapter.listOpenPRs("example", "demo");
    expect(prs).toHaveLength(1);
    expect(prs[0]!.mergeStateStatus).toBe("CLEAN");
    expect(prs[0]!.autoMerge?.mergeMethod).toBe("squash");
  });

  it("createPull sends the JSON body via stdin (no shell, no argv secrets)", async () => {
    const pr = await adapter.createPull("example", "demo", {
      head: "teamsync/alice/frontend/task-a1b2c3",
      base: "main",
      title: "Add homepage",
      body: "Add homepage\n\n---\nTeamSync",
    });
    expect(pr.number).toBe(1);
    expect(pr.headRefName).toBe("teamsync/alice/frontend/task-a1b2c3");
    const log = await fake.readLog();
    const createCall = log.find((l) => l.argv.includes("--method") && l.argv[l.argv.indexOf("--method") + 1] === "POST");
    expect(createCall).toBeDefined();
    expect(createCall!.argv).toContain("--input");
    // Body must travel on stdin, never interpolated into a shell string:
    expect(createCall!.argv.join(" ")).not.toContain("Add homepage");
  });

  it("createPull on 'already exists' (422) returns the existing PR — idempotent", async () => {
    const input = { head: "teamsync/alice/frontend/dup-a1b2c3", base: "main", title: "Dup", body: "b" };
    const first = await adapter.createPull("example", "demo", input);
    const second = await adapter.createPull("example", "demo", input);
    expect(second.number).toBe(first.number);
    const state = await fake.readState();
    expect((state.prs as unknown[]).length).toBe(1);
  });

  it("enableAutoMerge issues the GraphQL mutation with typed args", async () => {
    const state = defaultState();
    state.prs = [
      {
        node_id: "PR_node_1",
        number: 1,
        html_url: "u",
        title: "t",
        state: "open",
        user: { login: "alice" },
        head: { ref: "b", sha: "a" },
        base: { ref: "main", sha: "b" },
        mergeable: true,
        mergeable_state: "clean",
        auto_merge: null,
      },
    ];
    await fake.setState(state);
    await adapter.enableAutoMerge("example", "demo", 1, "squash");
    const log = await fake.readLog();
    // First the node-id lookup query (typed -F num), then the mutation.
    const lookupCall = log.find((l) => l.argv.some((a) => a.startsWith("query=query(\$o:String!")));
    expect(lookupCall).toBeDefined();
    expect(lookupCall!.argv.some((a) => a === "num=1")).toBe(true);
    const mutationCall = log.find((l) => l.argv.some((a) => a.includes("enablePullRequestAutoMerge")));
    expect(mutationCall).toBeDefined();
    const queryArg = mutationCall!.argv.find((a) => a.startsWith("query="))!;
    expect(queryArg).toContain("enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m})");
    expect(mutationCall!.argv.some((a) => a === "id=PR_node_1")).toBe(true);
    expect(mutationCall!.argv.some((a) => a === "m=SQUASH")).toBe(true);
    const st = await fake.readState();
    expect(st.autoMergeEnabled).toEqual(["PR_node_1"]);
  });

  it("getChecks normalizes conclusions — skipped stays skipped", async () => {
    const state = defaultState();
    state.checkRuns = {
      total_count: 3,
      check_runs: [
        { name: "integration", head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "completed", conclusion: "success" },
        { name: "skippable", head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "completed", conclusion: "skipped" },
        { name: "running", head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "in_progress", conclusion: null },
      ],
    };
    await fake.setState(state);
    const checks = await adapter.getChecks("example", "demo", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(checks.find((c) => c.name === "integration")!.state).toBe("success");
    expect(checks.find((c) => c.name === "skippable")!.state).toBe("skipped");
    expect(checks.find((c) => c.name === "running")!.state).toBe("pending");
  });

  it("getReviewDecision degrades to null on errors", async () => {
    const state = defaultState();
    state.prs = [];
    await fake.setState(state);
    expect(await adapter.getReviewDecision("example", "demo", 99)).toBeNull();
  });

  it("protection info: readable when permitted, null when 404 (MOCK both ways)", async () => {
    const ok = await adapter.getBranchProtection("example", "demo", "main");
    expect(ok?.requiredChecks).toEqual(["integration"]);
    expect(ok?.requireUpToDateBranch).toBe(true);

    const state = defaultState();
    state.protection = null;
    await fake.setState(state);
    expect(await adapter.getBranchProtection("example", "demo", "main")).toBeNull();
  });
});

describe("error mapping (MOCK failures)", () => {
  it("401 → auth error with login hint, exit 4", async () => {
    const state = defaultState();
    state.error = { status: 401 };
    await fake.setState(state);
    const err = await adapter.whoAmI().catch((e) => e);
    expect(err).toBeInstanceOf(TeamsyncError);
    expect((err as TeamsyncError).exitCode).toBe(ExitCode.AUTH);
  });

  it("404 → not-found, exit 6", async () => {
    const state = defaultState();
    state.error = { status: 404 };
    await fake.setState(state);
    const err = await adapter.getRepo("example", "missing").catch((e) => e);
    expect((err as TeamsyncError).exitCode).toBe(ExitCode.NOT_FOUND);
  });

  it("403 → blocked, exit 3", async () => {
    const state = defaultState();
    state.error = { status: 403 };
    await fake.setState(state);
    const err = await adapter.getRepo("example", "demo").catch((e) => e);
    expect((err as TeamsyncError).exitCode).toBe(ExitCode.BLOCKED);
  });

  it("rate limit → network, exit 5", async () => {
    const state = defaultState();
    state.error = { status: 429 };
    await fake.setState(state);
    const err = await adapter.whoAmI().catch((e) => e);
    expect((err as TeamsyncError).exitCode).toBe(ExitCode.NETWORK);
  });

  it("mapGhError classifies message text without HTTP markers", () => {
    expect(mapGhError("API rate limit exceeded for x", "ctx").exitCode).toBe(ExitCode.NETWORK);
    expect(mapGhError("gh: Bad credentials", "ctx").exitCode).toBe(ExitCode.AUTH);
    expect(mapGhError("dial tcp: no such host", "ctx").exitCode).toBe(ExitCode.NETWORK);
  });

  it("missing gh binary → GhNotInstalledError with install hints", async () => {
    const broken = new GhCliAdapter({ ghPath: "/nonexistent/gh-xyz" });
    const err = await broken.whoAmI().catch((e) => e);
    expect(err).toBeInstanceOf(GhNotInstalledError);
    expect((err as GhNotInstalledError).hints.join(" ")).toMatch(/install/i);
  });

  it("ghApi propagates stderr-redacted errors", async () => {
    const state = defaultState();
    state.error = { status: 401 };
    await fake.setState(state);
    await expect(ghApi(["api", "user"], { ghPath: fake.ghPath })).rejects.toThrow(/401|credentials/i);
  });
});
