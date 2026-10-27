// `teamsync join OWNER/REPO --role ROLE` — clone safely (or adopt an existing
// matching clone), validate access + shared config, and store the role
// locally. Members must already have GitHub access; join never grants it.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "../core/git.js";
import { parseRepositorySlug, isValidRoleName, parseConfig, CONFIG_PATH } from "../core/config.js";
import { usageError, blockedError, notFoundError } from "../core/errors.js";
import { saveMembership } from "../core/userstate.js";
import type { Output } from "../ui/output.js";
import type { CommandContext } from "./context.js";

export interface JoinOptions {
  role: string;
  path?: string;
}

export async function runJoin(ctx: CommandContext, out: Output, repoArg: string, opts: JoinOptions): Promise<void> {
  const slug = parseRepositorySlug(repoArg);
  if (!slug) {
    throw usageError(`Invalid repository "${repoArg}" — expected OWNER/REPO.`, []);
  }
  if (!isValidRoleName(opts.role)) {
    throw usageError(`Invalid role "${opts.role}" — lowercase letters, digits, dot, dash, underscore (max 63).`, []);
  }

  // Access check FIRST — we never half-clone something the user can't use.
  const info = await ctx.adapter.getRepo(slug.owner, slug.repo);
  if (info.viewerPermission === "none") {
    throw notFoundError(`Your account has no access to ${info.nameWithOwner}.`, [
      "Ask a repository admin to add you. `teamsync join` never grants access.",
    ]);
  }

  const defaultBranch = info.defaultBranch;
  const dest = path.resolve(process.cwd(), opts.path ?? slug.repo);

  // Destination rules: missing or empty → clone. Existing matching clone →
  // adopt. Non-empty and not a matching clone → refuse (never overwrite).
  let git: GitClient;
  let adopted = false;
  const destStat = await stat(dest).catch(() => null);
  if (destStat && !destStat.isDirectory()) {
    throw blockedError(`Destination ${dest} exists and is not a directory — refusing to touch it.`);
  }
  if (destStat) {
    const entries = await readdir(dest);
    if (entries.length > 0) {
      const probe = new GitClient(dest);
      const isClone = (await probe.isRepo()) && (await probe.remoteSlug()) === info.nameWithOwner;
      if (!isClone) {
        throw blockedError(
          `Destination ${dest} is not empty and is not a clone of ${info.nameWithOwner} — refusing to overwrite.`,
          ["Choose another path with --path, or remove the directory yourself if it is safe to remove."],
        );
      }
      git = probe;
      adopted = true;
    } else {
      git = await GitClient.clone(`https://github.com/${info.nameWithOwner}.git`, dest);
    }
  } else {
    git = await GitClient.clone(`https://github.com/${info.nameWithOwner}.git`, dest);
  }

  // Validate shared configuration on the default branch (remote-tracking ref,
  // so this works regardless of the local checkout).
  await git.fetch("origin");
  const configRaw = await git.showFile(`refs/remotes/origin/${defaultBranch}:${CONFIG_PATH}`);
  if (configRaw === null || configRaw.trim() === "") {
    throw notFoundError(`${info.nameWithOwner} has no ${CONFIG_PATH} on branch '${defaultBranch}'.`, [
      "The repository owner must run `teamsync init --repo " + info.nameWithOwner + "` first.",
    ]);
  }
  let config;
  try {
    config = parseConfig(JSON.parse(configRaw), CONFIG_PATH);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw usageError(`${CONFIG_PATH} in ${info.nameWithOwner} is not valid JSON.`, [
        "The repository owner must fix it.",
      ]);
    }
    throw err;
  }

  if (!config.roles[opts.role]) {
    throw usageError(
      `Role "${opts.role}" is not defined in the repository's ${CONFIG_PATH}.`,
      [`Available roles: ${Object.keys(config.roles).join(", ")}.`],
    );
  }

  await saveMembership({
    repository: info.nameWithOwner,
    role: opts.role,
    clonePath: dest,
    joinedAt: new Date().toISOString(),
  });

  out.success(`${adopted ? "Adopted existing clone" : "Cloned"} ${info.nameWithOwner} → ${dest}`);
  out.detail(`Role: ${opts.role} (advisory paths: ${config.roles[opts.role]!.paths.join(", ")})`);
  out.detail(`Default branch: ${config.defaultBranch}`);
  out.say("");
  out.say("Next: `teamsync start <task-name>` inside the clone to create your task branch.");
  ctx.events.emit({
    ts: new Date().toISOString(),
    type: "command.end",
    data: { repository: info.nameWithOwner, role: opts.role, adopted },
  });
}
