// Shared helpers for commands: repo/config discovery, membership resolution.
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "../core/git.js";
import { loadConfigFromDir, CONFIG_PATH } from "../core/config.js";
import { configError, notFoundError } from "../core/errors.js";
import { loadUserState, findMembership } from "../core/userstate.js";

export interface ResolvedRepo {
  root: string;
  git: GitClient;
  config: Awaited<ReturnType<typeof loadConfigFromDir>>;
  role: string | null;
}

/** Find the worktree root walking up from cwd (like git). */
async function findRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  const { root } = path.parse(dir);
  while (true) {
    try {
      await access(path.join(dir, ".git"));
      return dir;
    } catch {
      // keep walking
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/**
 * Resolve the current repository for commands that mutate things.
 * Ensures: inside a repo, config exists+valid, remote matches config.
 */
export async function resolveEnrolledRepo(cwd: string): Promise<ResolvedRepo> {
  const root = await findRoot(cwd);
  if (!root) {
    throw notFoundError("Not inside a git repository.", [
      "Run `teamsync join OWNER/REPO --role ROLE` inside your clone first.",
    ]);
  }
  const git = new GitClient(root);
  if (!(await git.isRepo())) {
    throw notFoundError("Not inside a git repository.", [
      "Run `teamsync join OWNER/REPO --role ROLE` inside your clone first.",
    ]);
  }

  let config;
  try {
    config = await loadConfigFromDir(root);
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
      throw configError(`No ${CONFIG_PATH} found in this repository.`, [
        "Ask the repository owner to run `teamsync init --repo OWNER/REPO`.",
        "Or run `teamsync join OWNER/REPO --role ROLE` for a fresh clone with shared config.",
      ]);
    }
    throw err;
  }

  const remoteSlug = await git.remoteSlug();
  if (remoteSlug !== config.repository) {
    throw configError(
      `This clone's 'origin' (${remoteSlug ?? "none"}) does not match the configured repository (${config.repository}).`,
      ["Verify you are in the right clone, or fix origin: `git remote set-url origin git@github.com:" + config.repository + ".git`."],
    );
  }

  const state = await loadUserState();
  const membership = findMembership(state, config.repository, root);
  return {
    root,
    git,
    config,
    role: membership?.role ?? null,
  };
}

export async function readTextFile(p: string): Promise<string> {
  return readFile(p, "utf8");
}
