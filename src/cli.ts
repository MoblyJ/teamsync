// TeamSync CLI entry point. Presentation + exit codes only; logic lives in
// src/core (reusable by a future dashboard without this file).
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { makeContext, type GlobalOptions } from "./commands/context.js";
import { runDoctor } from "./commands/doctor.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runInit } from "./commands/init.js";
import { runJoin } from "./commands/join.js";
import { runStart } from "./commands/start.js";
import { runSubmit } from "./commands/submit.js";
import { runStatus } from "./commands/status.js";
import { runWatch } from "./commands/watch.js";
import { runSync } from "./commands/sync.js";
import { isTeamsyncError, ExitCode } from "./core/errors.js";
import { GhNotInstalledError } from "./core/github.js";
import { makeOutput } from "./ui/output.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  name: string;
};

const program = new Command();
program
  .name("teamsync")
  .description(
    "Git-based team collaboration for small teams: role-aware branches, PRs, and GitHub-native auto-merge.",
  )
  .version(pkg.version, "-V, --version")
  .showHelpAfterError("(run `teamsync --help` for usage)")
  // Global options live on the root; subcommands read them via parent.opts().
  .option("--json", "machine-readable JSON output (where supported)", false)
  .option("--events <file>", "append structured JSONL events to <file> (dashboard integration seam)")
  .option("--gh-path <path>", "path to the gh executable (default: PATH lookup)");

function ctxFor(opts: GlobalOptions, command: string) {
  return makeContext(opts, command);
}

function fail(err: unknown): never {
  const out = makeOutput(false);
  if (err instanceof GhNotInstalledError || isTeamsyncError(err)) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify((err as { toJSON(): unknown }).toJSON(), null, 2));
    } else {
      out.error(`error: ${(err as Error).message}`);
      for (const h of (err as { hints?: string[] }).hints ?? []) out.detail(`→ ${h}`);
    }
    process.exit((err as { exitCode: number }).exitCode ?? ExitCode.GENERAL);
  }
  out.error(`unexpected error: ${(err as Error).stack ?? String(err)}`);
  process.exit(ExitCode.GENERAL);
}

async function confirmYes(): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question("Proceed? [y/N] ")).trim());
  } finally {
    rl.close();
  }
}
void confirmYes;

program
  .command("doctor")
  .description("Check runtime, Git, gh, auth, repo access, CI, and auto-merge prerequisites. Explains; never installs.")
  .option("--repo <owner/repo>", "check a specific repository instead of the current clone")
  .action(async (opts: { repo?: string }, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "doctor");
    const out = makeOutput(ctx.json);
    const { checks, healthy } = await runDoctor(ctx, out, { repo: opts.repo });
    if (ctx.json) out.json({ healthy, checks });
    process.exit(healthy ? ExitCode.OK : ExitCode.GENERAL);
  });

program
  .command("login")
  .description("Log in with GitHub (delegates to `gh auth login`; browser/device flow handled by gh).")
  .action(async (_opts, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "login");
    const out = makeOutput(ctx.json);
    await runLogin(ctx, out);
  });

program
  .command("logout")
  .description("Remove the shared GitHub login after confirmation (gh login is shared with other tools).")
  .option("-y, --yes", "skip confirmation (noninteractive)")
  .action(async (opts: { yes?: boolean }, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "logout");
    const out = makeOutput(ctx.json);
    await runLogout(ctx, out, opts);
  });

program
  .command("init")
  .description("Prepare shared config, PR template, CI gate, and contracts scaffold in a setup branch/PR.")
  .requiredOption("--repo <owner/repo>", "repository to enroll (OWNER/REPO)")
  .option("-y, --yes", "write the listed files without prompting (noninteractive)")
  .option("--dry-run", "show what would be created without writing")
  .action(async (opts: { repo: string; yes?: boolean; dryRun?: boolean }, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "init");
    const out = makeOutput(ctx.json);
    await runInit(ctx, out, opts);
  });

program
  .command("join <owner/repo>")
  .description("Clone (or adopt) the repository, validate access + shared config, and record your role locally.")
  .requiredOption("--role <role>", "your role (must exist in .teamsync/config.json)")
  .option("--path <dir>", "clone destination (default: ./<repo>)")
  .action(async (repo: string, opts: { role: string; path?: string }, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "join");
    const out = makeOutput(ctx.json);
    await runJoin(ctx, out, repo, opts);
  });

program
  .command("start <task>")
  .description("Create a unique task branch teamsync/<login>/<role>/<task>-<suffix> from the default branch.")
  .action(async (task: string, _opts, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "start");
    const out = makeOutput(ctx.json);
    const result = await runStart(ctx, out, task);
    if (ctx.json) out.json(result);
  });

program
  .command("submit")
  .description("Stage explicitly selected changes, commit, push, and create/update one PR, then report true state.")
  .option("-m, --message <message>", "commit message (required when committing changes)")
  .option("-a, --all", "stage all current changes (minus excluded secret files)", false)
  .option("--paths <paths...>", "stage only these repo-relative paths")
  .option("--draft", "open the PR as a draft", false)
  .action(async (opts: { message?: string; all?: boolean; paths?: string[]; draft?: boolean }, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "submit");
    const out = makeOutput(ctx.json);
    await runSubmit(ctx, out, opts);
  });

program
  .command("status")
  .description("Show open team PRs, roles, checks, conflicts, merge eligibility, and blockers.")
  .option("--all", "include PRs not created via TeamSync branches", false)
  .action(async (opts: { all?: boolean }, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "status");
    const out = makeOutput(ctx.json);
    const { status } = await runStatus(ctx, out, opts);
    if (ctx.json) out.json(status);
  });

program
  .command("watch")
  .description("Poll status until nothing is waiting (read-only; server-side merging needs no watcher).")
  .option("-i, --interval <seconds>", "poll interval in seconds (min 5, default 30)", "30")
  .option("--once", "refresh once and exit", false)
  .action(async (opts: { interval: string; once?: boolean }, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "watch");
    const out = makeOutput(ctx.json);
    await runWatch(ctx, out, { intervalSeconds: Number(opts.interval), once: opts.once });
  });

program
  .command("sync")
  .description("Fetch and update: fast-forward the default branch; merge base into task branches. Refuses dirty trees.")
  .action(async (_opts, command: Command) => {
    const global = command.parent!.opts() as GlobalOptions;
    const ctx = ctxFor(global, "sync");
    const out = makeOutput(ctx.json);
    const result = await runSync(ctx, out);
    if (ctx.json) out.json(result);
  });

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  // commander routes --help/--version through exitOverride; those are successes.
  const code = (err as { code?: string }).code;
  if (
    code === "commander.helpDisplayed" ||
    code === "commander.version" ||
    code === "commander.help"
  ) {
    process.exit(ExitCode.OK);
  }
  if (
    code === "commander.missingMandatoryOptionValue" ||
    code === "commander.unknownOption" ||
    code === "commander.missingArgument" ||
    code === "commander.missingSubcommand" ||
    code === "commander.invalidArgument"
  ) {
    console.error((err as Error).message);
    process.exit(ExitCode.USAGE);
  }
  fail(err);
}
