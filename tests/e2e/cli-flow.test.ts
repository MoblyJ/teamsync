// End-to-end test: the REAL built CLI (bin/teamsync.js → dist) driven as a
// subprocess through the documented command flow, with GitHub mocked at the
// gh-executable boundary (fake gh shim) and git transport pointed at a local
// bare repo. This exercises arg parsing, exit codes, and output rendering —
// not just library code. All GitHub responses are MOCK.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeRepoFixture, type FixtureRepo } from "../helpers/git-fixtures.js";
import { makeFakeGh, type FakeGh } from "../helpers/fake-gh.js";

const BIN = path.resolve(import.meta.dirname, "..", "..", "bin", "teamsync.js");
const NODE = process.execPath;

let fixture: FixtureRepo;
let fakeGh: FakeGh;
let homeDir: string;

beforeAll(async () => {
  fakeGh = await makeFakeGh();
});

afterAll(async () => {
  await fakeGh?.cleanup();
  await fixture?.cleanup();
});

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "teamsync-e2e-home-"));
  const gitCfgDir = await mkdtemp(path.join(tmpdir(), "teamsync-e2e-gitcfg-"));
  const gitCfg = path.join(gitCfgDir, "gitconfig");
  await writeFile(gitCfg, "", "utf8");
  process.env.GIT_CONFIG_GLOBAL = gitCfg;
  process.env.TEAMSYNC_HOME = homeDir;
  fixture = await makeRepoFixture(["join-clone"], "https://github.com/example/demo.git");
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd?: string): RunResult {
  const res = spawnSync(NODE, [BIN, ...args], {
    cwd: cwd ?? fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    timeout: 120_000,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("e2e: install-level CLI flow (real binary, MOCK GitHub, real git)", () => {
  it("exposes working help and version", () => {
    const help = cli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/doctor/);
    expect(help.stdout).toMatch(/submit/);

    const version = cli(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("login without a TTY fails with an actionable message (exit 4)", () => {
    const r = cli(["login"]);
    expect(r.status).toBe(4);
    expect(r.stderr + r.stdout).toMatch(/interactive terminal|gh auth login/i);
  });

  it("doctor reports healthy against the MOCK GitHub with all shims in place", () => {
    const r = cli(["--gh-path", fakeGh.ghPath, "doctor", "--repo", "example/demo"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/node:/);
    expect(r.stdout).toMatch(/gh:/);
    expect(r.stdout).toMatch(/Critical requirements satisfied/);
  });

  it("walks join → start → submit → status → sync → logout", () => {
    const ghOpt = ["--gh-path", fakeGh.ghPath];
    const clone = path.join(fixture.root, "join-clone");

    // join into a NEW directory: real clone through insteadOf transport.
    const fresh = path.join(fixture.root, "fresh-clone");
    const joinFresh = cli([...ghOpt, "join", "example/demo", "--role", "frontend", "--path", fresh]);
    expect(joinFresh.status).toBe(0);
    expect(joinFresh.stdout).toMatch(/Cloned example\/demo/);

    // join into the fixture's existing clone: adopted, not overwritten.
    const join = cli([...ghOpt, "join", "example/demo", "--role", "frontend", "--path", clone]);
    expect(join.status).toBe(0);
    expect(join.stdout).toMatch(/Adopted existing clone example\/demo/);

    // start: unique task branch from the default branch.
    const start = cli([...ghOpt, "start", "homepage"], clone);
    expect(start.status).toBe(0);
    expect(start.stdout).toMatch(/teamsync\/alice\/frontend\/homepage-[0-9a-f]{6}/);

    // submit --all: commit + push + one PR + auto-merge enrollment (MOCK).
    const pagePath = path.join(clone, "apps", "frontend", "homepage.js");
    writeFileSync(pagePath, "// homepage\n");
    const submit = cli([...ghOpt, "submit", "--all", "-m", "Add homepage"], clone);
    expect(submit.status).toBe(0);
    expect(submit.stdout).toMatch(/PR #1:/);

    // Repeated submit reuses the SAME PR (MOCK state shows one PR).
    appendFileSync(pagePath, "// update\n");
    const submit2 = cli([...ghOpt, "submit", "--all", "-m", "Update homepage"], clone);
    expect(submit2.status).toBe(0);
    expect(submit2.stdout).toMatch(/PR #1:/);

    // status --json reports the PR truthfully.
    const status = cli([...ghOpt, "--json", "status"], clone);
    expect(status.status).toBe(0);
    const parsed = JSON.parse(status.stdout);
    expect(parsed.repository).toBe("example/demo");
    expect(parsed.prs).toHaveLength(1);
    expect(parsed.prs[0].number).toBe(1);
    expect(parsed.prs[0].role).toBe("frontend");
    expect(parsed.prs[0].mine).toBe(true);
    // A brand-new PR with no check runs yet is NOT claimed merged/eligible:
    expect(["checks-blocked", "checks-pending", "manual-mode"]).toContain(parsed.prs[0].state);

    // sync on the task branch: base unchanged → up-to-date, no rewrites.
    const sync = cli([...ghOpt, "sync"], clone);
    expect(sync.status).toBe(0);
    expect(sync.stdout).toMatch(/already contains|already up to date/i);

    // sync refuses dirty worktrees with exit 3, files preserved.
    appendFileSync(pagePath, "// uncommitted\n");
    const dirty = cli([...ghOpt, "sync"], clone);
    expect(dirty.status).toBe(3);
    expect(dirty.stderr).toMatch(/dirty/i);
    expect(readFileSync(pagePath, "utf8")).toContain("// uncommitted\n");

    // logout --yes removes the shared login after the flag confirms intent.
    const logout = cli([...ghOpt, "logout", "--yes"], clone);
    expect(logout.status).toBe(0);
    expect(logout.stdout).toMatch(/Logged out alice/);

    // The (MOCK) GitHub side saw exactly one PR, auto-merge enrolled.
    const state = execFileSync(NODE, ["-e", `console.log(require('fs').readFileSync(${JSON.stringify(fakeGh.statePath)}, 'utf8'))`], {
      encoding: "utf8",
    });
    const ghState = JSON.parse(state);
    expect(ghState.prs).toHaveLength(1);
    expect(ghState.autoMergeEnabled).toHaveLength(1);
  });
});
