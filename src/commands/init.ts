// `teamsync init --repo OWNER/REPO` — run by the repo owner inside a clean
// matching clone. Creates a setup branch with shared config, PR template, CI
// gate, and contracts scaffold — preserving every pre-existing file — then
// opens a PR and prints the exact admin settings needed for auto-merge.
// TeamSync never edits repository settings or grants access via API.
import { writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { serializeConfig, parseConfig, parseRepositorySlug } from "../core/config.js";
import { usageError, blockedError } from "../core/errors.js";
import { suffixFrom, BRANCH_PREFIX } from "../core/branch.js";
import { SETUP_FILES, readTemplate } from "./template-files.js";
import { resolveEnrolledRepo } from "./shared.js";
import { enrollAutoMerge } from "./automerge.js";
import type { Output } from "../ui/output.js";
import type { CommandContext } from "./context.js";

export interface InitOptions {
  repo?: string;
  yes?: boolean; // skip confirmation of the file list (noninteractive)
  dryRun?: boolean;
}

export async function runInit(ctx: CommandContext, out: Output, opts: InitOptions): Promise<void> {
  // Determine the target repository: explicit flag, or the current clone.
  const git = (await import("../core/git.js")).GitClient;
  const client = new git(ctx.cwd);
  if (!(await client.isRepo())) {
    throw usageError("`teamsync init` must run inside a clone of the repository you are enrolling.", [
      "Clone OWNER/REPO with git, cd into it, then run `teamsync init --repo OWNER/REPO`.",
    ]);
  }
  const remoteSlug = await client.remoteSlug();
  const target = opts.repo ?? remoteSlug;
  if (!target) {
    throw usageError("No --repo given and the clone has no origin remote.", [
      "Run `teamsync init --repo OWNER/REPO` inside your clone.",
    ]);
  }
  if (!parseRepositorySlug(target)) {
    throw usageError(`Invalid repository "${target}" — expected OWNER/REPO.`, []);
  }
  if (remoteSlug && remoteSlug !== target) {
    throw usageError(`This clone's origin (${remoteSlug}) does not match --repo (${target}).`, [
      "Run init inside a clone of the repository you are enrolling.",
    ]);
  }

  // Clean worktree required: we will create a branch and commit files.
  if (!(await client.isClean())) {
    throw blockedError("Worktree is dirty — `teamsync init` refuses to mix your uncommitted changes into the setup PR.", [
      "Commit or stash your changes first (TeamSync never stashes for you).",
    ]);
  }

  const me = await ctx.adapter.whoAmI();
  const info = await ctx.adapter.getRepo(...(target.split("/") as [string, string]));
  const defaultBranch = info.defaultBranch;

  // Put the setup branch on top of the freshest default branch.
  const current = await client.currentBranch();
  await client.fetch("origin");
  if (current !== defaultBranch) {
    await client.checkout(defaultBranch);
  }
  await client.mergeFastForwardOnly(`origin/${defaultBranch}`);

  // Build the config first so the file list is complete before committing.
  const draft = {
    version: 1,
    repository: target,
    defaultBranch,
    checks: { required: ["integration"] },
    mergePolicy: { method: info.allowSquashMerge ? "squash" : "merge", autoMerge: true, deleteBranchOnMerge: true },
    createdBy: me.login,
  };
  // Normalize through the validator so roles/sharedPaths get canonical defaults.
  const canonical = parseConfig(draft, "(generated)");


  const written: string[] = [];
  const preserved: string[] = [];
  const plan: Array<{ repoPath: string; content: string; description: string }> = [
    ...await Promise.all(
      SETUP_FILES.map(async (f) => ({
        repoPath: f.repoPath,
        content: await readTemplate(f.templateName),
        description: f.description,
      })),
    ),
    { repoPath: ".teamsync/config.json", content: serializeConfig(canonical), description: "validated shared TeamSync config" },
  ];

  // Existing files are never overwritten.
  for (const item of plan) {
    const abs = path.join(client.cwd, item.repoPath);
    let exists = false;
    try {
      await access(abs);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      preserved.push(item.repoPath);
    } else {
      written.push(item.repoPath);
    }
  }

  out.say(`Enrolling ${target} (default branch: ${defaultBranch}) for TeamSync collaboration.`);
  out.list([
    ...written.map((p) => `create  ${p}`),
    ...preserved.map((p) => `keep    ${p} (exists — not modified)`),
  ]);

  if (opts.dryRun) {
    out.say("Dry run: no branch, commit, or PR created.");
    return;
  }
  if (opts.yes !== true && process.stdin.isTTY === true && written.length > 0) {
    // Interactive users get one explicit confirmation; scripts use --yes.
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Create the setup branch and PR with the files listed above? [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      out.say("Aborted — nothing was written.");
      return;
    }
  }

  const branch = `${BRANCH_PREFIX}/setup/${me.login}-${suffixFrom()}`;
  await client.createAndCheckout(branch);

  for (const item of plan) {
    if (preserved.includes(item.repoPath)) continue;
    const abs = path.join(client.cwd, item.repoPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, item.content, "utf8");
  }
  await client.add(plan.map((p) => p.repoPath));
  await client.commit("TeamSync: shared config, PR template, CI integration gate\n\nGenerated by teamsync init. Existing files were preserved.");
  await client.pushNewBranch(branch, "origin");

  const pr = await ctx.adapter.createPull(target.split("/")[0]!, target.split("/")[1]!, {
    head: branch,
    base: defaultBranch,
    title: "TeamSync: repository setup (config, PR template, CI gate, contracts)",
    body: [
      "Generated by `teamsync init`.",
      "",
      "### What's inside",
      "- `.teamsync/config.json` — validated shared configuration (roles, paths, required checks, merge policy)",
      "- `.github/workflows/integration.yml` — CI gate that runs on `pull_request` (never `pull_request_target`), least-privilege, with an always-on aggregate `integration` check",
      "- `.github/PULL_REQUEST_TEMPLATE.md` — role/scope checklist",
      "- `packages/contracts/` — shared contract location for cross-role types",
      "- `docs/teamsync.md` — collaboration guidance",
      "",
      preserved.length > 0 ? `### Preserved (not modified)\n${preserved.map((p) => `- \`${p}\``).join("\n")}` : "",
      "",
      "### Admin settings still needed (TeamSync cannot and will not change these)",
      "1. Merge this PR.",
      info.allowAutoMerge
        ? "2. Auto-merge is already enabled on the repository. ✓"
        : "2. Settings → General → Pull Requests → enable **Allow auto-merge**.",
      "3. Settings → Branches → protect `" + defaultBranch + "`: require check **`integration`** and **require branches to be up to date before merging**.",
      "4. Settings → Actions → General → set default workflow permissions to **Read repository contents**.",
    ].join("\n"),
  });

  ctx.events.emit({ ts: new Date().toISOString(), type: "pr.created", data: { pr: pr.number, branch } });
  out.success(`Setup PR: ${pr.url}`);

  // Enroll auto-merge on the setup PR too (the admin merging it must not need
  // a second manual step).
  const enroll = await enrollAutoMerge(ctx, target, pr, info, canonical, out);
  if (enroll === "requested") out.detail("Auto-merge engaged: the setup PR merges itself once required checks pass.");
  if (enroll === "manual") out.detail("Manual merge mode: a human merges this PR after checks pass.");

  out.say("");
  out.say("Next steps (repository admin):");
  out.list([
    ...(info.allowAutoMerge ? [] : ["Enable 'Allow auto-merge' in repository settings."]),
    `Protect '${defaultBranch}': require check 'integration' + require up-to-date branches.`,
    "Set default workflow permissions to read-only (Settings → Actions).",
    "TeamSync never changes these settings for you.",
  ]);
}
