// Real-git test fixtures: a bare origin plus N independent clones. Nothing
// mocked inside git itself — the tests exercise actual branches, merges, and
// pushes, so failures here are real failures.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, executableName } from "../../src/core/proc.js";

const GIT = executableName("git");

export async function gitRun(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const res = await run(GIT, args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      ...env,
    },
  });
  if (!res.ok) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

export interface FixtureRepo {
  root: string;
  originPath: string;
  /** file helper: write inside the fixture working clone */
  cloneDir(name: string): string;
  cleanup(): Promise<void>;
}

/** Initial shared repository content matching a real enrolled team repo. */
export function initialFiles(): Record<string, string> {
  return {
    "README.md": "# Demo repo\n",
    ".teamsync/config.json": JSON.stringify({
      version: 1,
      repository: "example/demo",
      defaultBranch: "main",
      roles: {
        services: { paths: ["services/**"] },
        backend: { paths: ["apps/backend/**", "packages/contracts/**"] },
        frontend: { paths: ["apps/frontend/**", "packages/contracts/**"] },
        qa: { paths: ["tests/**", ".github/workflows/**"] },
      },
      sharedPaths: ["packages/contracts/**", "package.json"],
      checks: { required: ["integration"] },
      mergePolicy: { method: "squash", autoMerge: true, deleteBranchOnMerge: true },
    }, null, 2),
    "apps/backend/server.js": "console.log('backend');\n",
    "apps/frontend/index.js": "console.log('frontend');\n",
    "services/ingest.js": "console.log('services');\n",
    "packages/contracts/contracts.js": "export const SHARED = 'v1';\n",
  };
}

export async function makeRepoFixture(
  cloneNames: string[],
  /**
   * Clone from this URL (e.g. "https://github.com/example/demo.git") rather
   * than the bare path. When given, an `insteadOf` rewrite to the local bare
   * repo is written into the active GIT_CONFIG_GLOBAL file (which must be set
   * by the test and point at a writable file) BEFORE any transport happens,
   * so remote identity stays github.com while transport is local.
   */
  originUrl?: string,
): Promise<FixtureRepo> {
  const root = await mkdtemp(path.join(tmpdir(), "teamsync-test-"));
  const originPath = path.join(root, "origin.git");
  const seedDir = path.join(root, "seed");
  const transportUrl = originUrl ?? originPath;

  await mkdir(originPath, { recursive: true });
  if (originUrl && process.env.GIT_CONFIG_GLOBAL) {
    const { appendFile } = await import("node:fs/promises");
    // Forward slashes keep the file URL valid on Windows too.
    const originFileUrl = `file://${originPath.replace(/\\/g, "/")}`;
    await appendFile(
      process.env.GIT_CONFIG_GLOBAL,
      `[url "${originFileUrl}"]\n\tinsteadOf = ${originUrl}\n`,
      "utf8",
    );
  }

  await gitRun(originPath, ["init", "--bare", "--initial-branch=main", "."]);

  await mkdir(seedDir, { recursive: true });
  await gitRun(seedDir, ["init", "--initial-branch=main", "."]);
  await gitRun(seedDir, ["remote", "add", "origin", transportUrl]);
  for (const [rel, content] of Object.entries(initialFiles())) {
    const abs = path.join(seedDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await gitRun(seedDir, ["add", "."]);
  await gitRun(seedDir, ["commit", "-m", "initial team repository"]);
  await gitRun(seedDir, ["push", "origin", "main"]);

  const clones = new Map<string, string>();
  for (const name of cloneNames) {
    const dir = path.join(root, name);
    await gitRun(root, ["clone", transportUrl, dir]);
    await gitRun(dir, ["config", "user.name", name]);
    await gitRun(dir, ["config", "user.email", `${name}@example.com`]);
    clones.set(name, dir);
  }

  return {
    root,
    originPath,
    cloneDir: (name: string) => {
      const dir = clones.get(name);
      if (!dir) throw new Error(`no such clone: ${name}`);
      return dir;
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
