// Integration tests over REAL git repositories: a bare origin + four clones
// (one per role). Git itself is never mocked — branches, merges, pushes, and
// conflict aborts are genuine. GitHub is mocked at the adapter boundary only
// (FakeGitHubAdapter — MOCK results).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, appendFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeRepoFixture, gitRun, type FixtureRepo } from "../helpers/git-fixtures.js";
import { FakeGitHubAdapter } from "../helpers/fake-adapter.js";
import { GitClient } from "../../src/core/git.js";
import { runStart } from "../../src/commands/start.js";
import { runSubmit } from "../../src/commands/submit.js";
import { runSync } from "../../src/commands/sync.js";
import { saveMembership } from "../../src/core/userstate.js";
import { makeOutput } from "../../src/ui/output.js";
import { MemoryEventSink } from "../../src/core/events.js";
import { isTeamsyncError } from "../../src/core/errors.js";

let fixture: FixtureRepo;
let homeDir: string;
let globalGitConfig: string;

const out = makeOutput(false);
const silentOut = {
  say: () => {},
  detail: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
  list: () => {},
  json: () => {},
};

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "teamsync-home-"));
  globalGitConfig = path.join(await mkdtemp(path.join(tmpdir(), "teamsync-gitcfg-")), "gitconfig");
  await writeFile(globalGitConfig, "", "utf8");
  process.env.GIT_CONFIG_GLOBAL = globalGitConfig;
  process.env.TEAMSYNC_HOME = homeDir;

  // Create the fixture only after GIT_CONFIG_GLOBAL is active: clones come
  // from the github.com URL and the fixture rewrites transport to the local
  // bare repo via insteadOf. Remote identity checks see github.com/example/demo.
  fixture = await makeRepoFixture(
    ["alice-services", "bob-backend", "carol-frontend", "dave-qa"],
    "https://github.com/example/demo.git",
  );
});

afterAll(async () => {
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.TEAMSYNC_HOME;
  await fixture?.cleanup();
});

function ctxFor(adapter: FakeGitHubAdapter, cwd: string) {
  return { adapter, events: new MemoryEventSink(), json: false, cwd };
}

function adapterFor(login: string): FakeGitHubAdapter {
  return new FakeGitHubAdapter({}, login);
}

async function membership(cloneName: string, login: string, role: string): Promise<void> {
  await saveMembership({
    repository: "example/demo",
    role,
    clonePath: fixture.cloneDir(cloneName),
    joinedAt: new Date().toISOString(),
  });
}

async function writeInClone(cloneName: string, rel: string, content: string): Promise<void> {
  const abs = path.join(fixture.cloneDir(cloneName), rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

describe("four teammates, four roles, real git", () => {
  it("creates four independent unique branches without overwriting one another", async () => {
    const teams = [
      { clone: "alice-services", login: "alice", role: "services" },
      { clone: "bob-backend", login: "bob", role: "backend" },
      { clone: "carol-frontend", login: "carol", role: "frontend" },
      { clone: "dave-qa", login: "dave", role: "qa" },
    ];
    const created: string[] = [];
    for (const t of teams) {
      await membership(t.clone, t.login, t.role);
      const result = await runStart(ctxFor(adapterFor(t.login), fixture.cloneDir(t.clone)), silentOut, "release-prep");
      expect(result.branch).toMatch(new RegExp(`^teamsync/${t.login}/${t.role}/release-prep-[0-9a-f]{6}$`));
      created.push(result.branch);
      // The branch exists locally in its own clone (pushing happens at submit):
      const local = await gitRun(fixture.cloneDir(t.clone), ["branch", "--list", "--format=%(refname:short)", result.branch]);
      expect(local.trim()).toBe(result.branch);
    }
    // Four distinct branch names — nobody overwrote anybody.
    expect(new Set(created).size).toBe(4);
  });

  it("refuses to start when the worktree is dirty, leaving files intact", async () => {
    await membership("bob-backend", "bob", "backend");
    const dir = fixture.cloneDir("bob-backend");
    const file = path.join(dir, "apps", "backend", "server.js");
    await appendFile(file, "\n// local uncommitted work\n", "utf8");
    const before = await readFile(file, "utf8");

    const err = await runStart(ctxFor(adapterFor("bob"), dir), silentOut, "new-thing").catch((e) => e);
    expect(isTeamsyncError(err)).toBe(true);
    expect((err as Error).message).toMatch(/dirty/i);
    expect(await readFile(file, "utf8")).toBe(before); // user data preserved
  });
});

describe("submit: staging rules, PR reuse, secret exclusion", () => {
  it("refuses to stage implicitly without --all or paths", async () => {
    await membership("carol-frontend", "carol", "frontend");
    const dir = fixture.cloneDir("carol-frontend");
    await writeInClone("carol-frontend", "apps/frontend/page.js", "// new page\n");
    await gitRun(dir, ["checkout", "-b", "teamsync/carol/frontend/page-a1b2c3"]);
    const err = await runSubmit(ctxFor(adapterFor("carol"), dir), silentOut, { message: "x" }).catch((e) => e);
    expect((err as Error).message).toMatch(/--all|explicit/i);
  });

  it("submits with --all: commits, pushes, creates ONE PR, enrolls auto-merge", async () => {
    await membership("carol-frontend", "carol", "frontend");
    const dir = fixture.cloneDir("carol-frontend");
    await gitRun(dir, ["checkout", "-b", "teamsync/carol/frontend/page-a1b2c3"]);
    await writeInClone("carol-frontend", "apps/frontend/page.js", "// new page\n");

    const adapter = adapterFor("carol");
    const result = await runSubmit(ctxFor(adapter, dir), silentOut, { all: true, message: "Add homepage" });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.pr).not.toBeNull();
    // Branch actually on the remote:
    const heads = await new GitClient(dir).lsRemoteHeads();
    expect(heads.has("teamsync/carol/frontend/page-a1b2c3")).toBe(true);
    // Exactly one PR in the (MOCK) GitHub state, with auto-merge enrolled:
    expect(adapter.prs).toHaveLength(1);
    expect(adapter.autoMergeCalls).toEqual([{ number: 1, method: "squash" }]);
    // Truthful state: fresh PR with no checks yet is NOT reported as merged/merged-eligible.
    expect(["checks-blocked", "checks-pending", "manual-mode"]).toContain(result.integration!.state);
  });

  it("repeated submissions reuse the same PR (no duplicates)", async () => {
    await membership("carol-frontend", "carol", "frontend");
    const dir = fixture.cloneDir("carol-frontend");
    const branch = "teamsync/carol/frontend/page-a1b2c3";
    await gitRun(dir, ["checkout", "-b", branch]);
    const adapter = adapterFor("carol");
    await writeInClone("carol-frontend", "apps/frontend/page.js", "// v1\n");
    const first = await runSubmit(ctxFor(adapter, dir), silentOut, { all: true, message: "Add page" });
    await writeInClone("carol-frontend", "apps/frontend/page.js", "// v2\n");
    const second = await runSubmit(ctxFor(adapter, dir), silentOut, { all: true, message: "Update page" });

    expect(second.pr!.number).toBe(first.pr!.number);
    expect(adapter.prs).toHaveLength(1); // never a duplicate PR
    // Three commits: initial + two task commits, no retry duplicates.
    const count = await gitRun(dir, ["rev-list", "--count", branch]);
    expect(Number(count.trim())).toBe(3);
  });

  it("excludes likely secret files from --all and reports them", async () => {
    await membership("bob-backend", "bob", "backend");
    const dir = fixture.cloneDir("bob-backend");
    await gitRun(dir, ["checkout", "-b", "teamsync/bob/backend/env-dead00"]);
    await writeInClone("bob-backend", "apps/backend/config.js", "export const x = 1;\n");
    await writeInClone("bob-backend", ".env", "SECRET=1\n");

    const adapter = adapterFor("bob");
    const result = await runSubmit(ctxFor(adapter, dir), out, { all: true, message: "Add config" });
    expect(result.excluded.map((e) => e.path)).toEqual([".env"]);
    // .env never reached the commit:
    const names = await gitRun(dir, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names).toContain("apps/backend/config.js");
    expect(names).not.toContain(".env");
    // And it is still on disk — exclusion never deletes user data:
    await expect(readFile(path.join(dir, ".env"), "utf8")).resolves.toBe("SECRET=1\n");
  });

  it("hard-refuses explicitly named secret files", async () => {
    await membership("bob-backend", "bob", "backend");
    const dir = fixture.cloneDir("bob-backend");
    await gitRun(dir, ["checkout", "-b", "teamsync/bob/backend/keys-beef00"]);
    await writeInClone("bob-backend", "server.pem", "-----BEGIN\n");
    const err = await runSubmit(ctxFor(adapterFor("bob"), dir), silentOut, {
      paths: ["server.pem"],
      message: "oops",
    }).catch((e) => e);
    expect(isTeamsyncError(err)).toBe(true);
    expect((err as Error).message).toMatch(/secret/i);
  });

  it("warns about edits outside the role's advisory paths but does not block", async () => {
    await membership("dave-qa", "dave", "qa");
    const dir = fixture.cloneDir("dave-qa");
    await gitRun(dir, ["checkout", "-b", "teamsync/dave/qa/cross-beef11"]);
    await writeInClone("dave-qa", "apps/backend/stray.js", "// qa edited backend\n");
    const adapter = adapterFor("dave");
    // Runs to completion; the warning path is exercised (warnings go to stderr).
    const result = await runSubmit(ctxFor(adapter, dir), silentOut, { all: true, message: "Cross-role edit" });
    expect(result.committed).toBe(true);
  });
});

describe("sync: fast-forward, merge, conflict safety", () => {
  it("fast-forwards the default branch and refuses diverged histories", async () => {
    const dir = fixture.cloneDir("alice-services");
    const seed = path.join(fixture.root, "seed");
    // Someone advances main on the origin:
    await gitRun(seed, ["commit", "--allow-empty", "-m", "base moves forward"]);
    await gitRun(seed, ["push", "origin", "main"]);

    const result = await runSync(ctxFor(adapterFor("alice"), dir), silentOut);
    expect(result.kind).toBe("fast-forward");
    expect(result.updated).toBe(true);

    // Now diverge: a local commit on main + another origin commit.
    await gitRun(seed, ["commit", "--allow-empty", "-m", "origin moves again"]);
    await gitRun(seed, ["push", "origin", "main"]);
    await gitRun(dir, ["commit", "--allow-empty", "-m", "local main commit"]);
    const err = await runSync(ctxFor(adapterFor("alice"), dir), silentOut).catch((e) => e);
    expect(isTeamsyncError(err)).toBe(true);
    expect((err as Error).message).toMatch(/diverged|fast-forward/i);
    // Local commit preserved:
    const subject = await gitRun(dir, ["log", "-1", "--format=%s", "main"]);
    expect(subject.trim()).toBe("local main commit");
  });

  it("merges the moved base into a task branch without rewriting history", async () => {
    await membership("bob-backend", "bob", "backend");
    const dir = fixture.cloneDir("bob-backend");
    const seed = path.join(fixture.root, "seed");

    await gitRun(dir, ["checkout", "-b", "teamsync/bob/backend/feature-dead11"]);
    await writeInClone("bob-backend", "apps/backend/feature.js", "// feature\n");
    await gitRun(dir, ["add", "."]);
    await gitRun(dir, ["commit", "-m", "feature work"]);

    // Main moves (unrelated file):
    await gitRun(seed, ["checkout", "main"]);
    await writeFile(path.join(seed, "README.md"), "# Demo repo updated\n", "utf8");
    await gitRun(seed, ["add", "."]);
    await gitRun(seed, ["commit", "-m", "readme update"]);
    await gitRun(seed, ["push", "origin", "main"]);

    const result = await runSync(ctxFor(adapterFor("bob"), dir), silentOut);
    expect(result.kind).toBe("merge");
    expect(result.updated).toBe(true);
    // Merge commit (no rebase): initial + base's readme commit + feature + merge.
    const count = await gitRun(dir, ["rev-list", "--count", "HEAD"]);
    expect(Number(count.trim())).toBe(4);
    // Feature file still present:
    await expect(readFile(path.join(dir, "apps", "backend", "feature.js"), "utf8")).resolves.toBe("// feature\n");
  });

  it("aborts cleanly on conflict, lists files, preserves user data", async () => {
    await membership("carol-frontend", "carol", "frontend");
    const dir = fixture.cloneDir("carol-frontend");
    const seed = path.join(fixture.root, "seed");
    const contractsInClone = path.join(dir, "packages", "contracts", "contracts.js");

    // Carol's task branch edits the shared contract:
    await gitRun(dir, ["checkout", "-b", "teamsync/carol/frontend/contract-beef22"]);
    await writeFile(contractsInClone, "export const SHARED = 'carol-version';\n", "utf8");
    await gitRun(dir, ["add", "."]);
    await gitRun(dir, ["commit", "-m", "carol contract change"]);

    // Meanwhile main edits THE SAME LINE:
    await gitRun(seed, ["checkout", "main"]);
    await writeFile(path.join(seed, "packages", "contracts", "contracts.js"), "export const SHARED = 'main-version';\n", "utf8");
    await gitRun(seed, ["add", "."]);
    await gitRun(seed, ["commit", "-m", "main contract change"]);
    await gitRun(seed, ["push", "origin", "main"]);

    const result = await runSync(ctxFor(adapterFor("carol"), dir), silentOut);
    expect(result.kind).toBe("conflict");
    expect(result.conflictFiles).toEqual(["packages/contracts/contracts.js"]);
    expect(result.guidance!.join(" ")).toMatch(/git merge/i);

    // Worktree restored exactly: clean status, Carol's content untouched.
    const client = new GitClient(dir);
    expect(await client.isClean()).toBe(true);
    await expect(readFile(contractsInClone, "utf8")).resolves.toBe("export const SHARED = 'carol-version';\n");
    // No merge in progress (rev-parse fails silently when MERGE_HEAD is absent):
    const mergeHead = await gitRun(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => "gone");
    expect(mergeHead).toBe("gone");
  });

  it("refuses to sync over a dirty worktree", async () => {
    const dir = fixture.cloneDir("dave-qa");
    await appendFile(path.join(dir, "README.md"), "\nuncommitted\n", "utf8");
    const err = await runSync(ctxFor(adapterFor("dave"), dir), silentOut).catch((e) => e);
    expect((err as Error).message).toMatch(/dirty/i);
  });
});

describe("submit over an unexpected remote branch state", () => {
  it("never force-pushes; rejects and preserves local commits", async () => {
    await membership("alice-services", "alice", "services");
    const dir = fixture.cloneDir("alice-services");
    const other = fixture.cloneDir("bob-backend");
    const branch = "teamsync/alice/services/collision-f00d11";

    // Alice submits normally once:
    await gitRun(dir, ["checkout", "-b", branch]);
    await writeInClone("alice-services", "services/one.js", "// one\n");
    await runSubmit(ctxFor(adapterFor("alice"), dir), silentOut, { all: true, message: "first" });

    // Someone force-replaces the same remote branch elsewhere (bypassing
    // TeamSync with plain git --force):
    await gitRun(other, ["fetch", "origin"]);
    await gitRun(other, ["checkout", "-b", branch, "origin/main"]);
    await writeInClone("bob-backend", "services/hijack.js", "// different history\n");
    await gitRun(other, ["add", "."]);
    await gitRun(other, ["commit", "-m", "hijacked"]);
    await gitRun(other, ["push", "--force", "origin", branch]);

    // Alice's next submit must be REJECTED, not overwritten:
    await writeInClone("alice-services", "services/two.js", "// two\n");
    const err = await runSubmit(ctxFor(adapterFor("alice"), dir), silentOut, { all: true, message: "second" }).catch((e) => e);
    expect(isTeamsyncError(err)).toBe(true);
    expect((err as Error).message).toMatch(/rejected|force/i);

    // Alice's local branch and both commits are intact:
    const log = await gitRun(dir, ["log", "--format=%s", branch]);
    expect(log).toContain("first");
    expect(log).toContain("second");
  });
});
