// TeamSync CLI entry point. Presentation + exit codes only; logic lives in
// src/core (reusable by a future dashboard without this file).
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { makeContext } from "./commands/context.js";
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
import { runServe } from "./commands/serve.js";
import { runStage, runCommit, runPush } from "./commands/simple.js";
import { runTeamCode, runTeamCreate, runTeamDelete, runTeamDiscover, runTeamHeartbeat, runTeamInfo, runTeamJoin, runTeamLeave, runTeamList, runTeamRemoveMember, runTeamRepo, runTeamRotateCode, } from "./commands/team.js";
import { isTeamsyncError, ExitCode } from "./core/errors.js";
import { GhNotInstalledError } from "./core/github.js";
import { makeOutput } from "./ui/output.js";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const program = new Command();
program
    .name("teamsync")
    .description("Git-based team collaboration for small teams: role-aware branches, PRs, and GitHub-native auto-merge.")
    .version(pkg.version, "-V, --version")
    .showHelpAfterError("(run `teamsync --help` for usage)")
    // Global options live on the root; subcommands read them via parent.opts().
    .option("--json", "machine-readable JSON output (where supported)", false)
    .option("--events <file>", "append structured JSONL events to <file> (dashboard integration seam)")
    .option("--gh-path <path>", "path to the gh executable (default: PATH lookup)");
function ctxFor(opts, command) {
    return makeContext(opts, command);
}
function fail(err) {
    const out = makeOutput(false);
    if (err instanceof GhNotInstalledError || isTeamsyncError(err)) {
        if (process.argv.includes("--json")) {
            console.log(JSON.stringify(err.toJSON(), null, 2));
        }
        else {
            out.error(`error: ${err.message}`);
            for (const h of err.hints ?? [])
                out.detail(`→ ${h}`);
        }
        process.exit(err.exitCode ?? ExitCode.GENERAL);
    }
    out.error(`unexpected error: ${err.stack ?? String(err)}`);
    process.exit(ExitCode.GENERAL);
}
async function confirmYes() {
    if (process.stdin.isTTY !== true)
        return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return /^y(es)?$/i.test((await rl.question("Proceed? [y/N] ")).trim());
    }
    finally {
        rl.close();
    }
}
void confirmYes;
program
    .command("doctor")
    .description("Check runtime, Git, gh, auth, repo access, CI, and auto-merge prerequisites. Explains; never installs.")
    .option("--repo <owner/repo>", "check a specific repository instead of the current clone")
    .action(async (opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "doctor");
    const out = makeOutput(ctx.json);
    const { checks, healthy } = await runDoctor(ctx, out, { repo: opts.repo });
    if (ctx.json)
        out.json({ healthy, checks });
    process.exit(healthy ? ExitCode.OK : ExitCode.GENERAL);
});
program
    .command("login")
    .description("Log in with GitHub (delegates to `gh auth login`; browser/device flow handled by gh).")
    .action(async (_opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "login");
    const out = makeOutput(ctx.json);
    await runLogin(ctx, out);
});
program
    .command("logout")
    .description("Remove the shared GitHub login after confirmation (gh login is shared with other tools).")
    .option("-y, --yes", "skip confirmation (noninteractive)")
    .action(async (opts, command) => {
    const global = command.parent.opts();
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
    .action(async (opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "init");
    const out = makeOutput(ctx.json);
    await runInit(ctx, out, opts);
});
program
    .command("join <owner/repo>")
    .description("Clone (or adopt) the repository, validate access + shared config, and record your role locally.")
    .requiredOption("--role <role>", "your role (must exist in .teamsync/config.json)")
    .option("--path <dir>", "clone destination (default: ./<repo>)")
    .action(async (repo, opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "join");
    const out = makeOutput(ctx.json);
    await runJoin(ctx, out, repo, opts);
});
program
    .command("start <task>")
    .description("Create a unique task branch teamsync/<login>/<role>/<task>-<suffix> from the default branch.")
    .action(async (task, _opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "start");
    const out = makeOutput(ctx.json);
    const result = await runStart(ctx, out, task);
    if (ctx.json)
        out.json(result);
});
program
    .command("submit")
    .description("Stage explicitly selected changes, commit, push, and create/update one PR, then report true state.")
    .option("-m, --message <message>", "commit message (required when committing changes)")
    .option("-a, --all", "stage all current changes (minus excluded secret files)", false)
    .option("--paths <paths...>", "stage only these repo-relative paths")
    .option("--draft", "open the PR as a draft", false)
    .action(async (opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "submit");
    const out = makeOutput(ctx.json);
    await runSubmit(ctx, out, opts);
});
program
    .command("status")
    .description("Show open team PRs, roles, checks, conflicts, merge eligibility, and blockers.")
    .option("--all", "include PRs not created via TeamSync branches", false)
    .action(async (opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "status");
    const out = makeOutput(ctx.json);
    const { status } = await runStatus(ctx, out, opts);
    if (ctx.json)
        out.json(status);
});
program
    .command("watch")
    .description("Poll status until nothing is waiting (read-only; server-side merging needs no watcher).")
    .option("-i, --interval <seconds>", "poll interval in seconds (min 5, default 30)", "30")
    .option("--once", "refresh once and exit", false)
    .action(async (opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "watch");
    const out = makeOutput(ctx.json);
    await runWatch(ctx, out, { intervalSeconds: Number(opts.interval), once: opts.once });
});
program
    .command("sync")
    .description("Fetch and update: fast-forward the default branch; merge base into task branches. Refuses dirty trees.")
    .action(async (_opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "sync");
    const out = makeOutput(ctx.json);
    const result = await runSync(ctx, out);
    if (ctx.json)
        out.json(result);
    // A conflict is a blocked outcome: nonzero exit so scripts can react.
    if (result.kind === "conflict")
        process.exit(ExitCode.BLOCKED);
});
// --- simple git-style verbs (manual step-by-step mode) ----------------------
program
    .command("stage")
    .description("Stage changes explicitly (--all or named paths). Excludes likely secret files; warns on cross-role/shared paths.")
    .option("-a, --all", "stage all current changes (minus excluded secrets)", false)
    .option("--paths <paths...>", "stage only these repo-relative paths")
    .action(async (opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "stage");
    await runStage(ctx, makeOutput(ctx.json), opts);
});
program
    .command("commit")
    .description("Commit the currently staged changes (use after `teamsync stage`).")
    .requiredOption("-m, --message <message>", "commit message")
    .action(async (opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "commit");
    await runCommit(ctx, makeOutput(ctx.json), opts.message);
});
program
    .command("push")
    .description("Push the current task branch to origin (never force-pushes; teamsync branches only).")
    .action(async (_opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "push");
    await runPush(ctx, makeOutput(ctx.json));
});
// --- MCP server (AI/vibe mode) -----------------------------------------------
program
    .command("mcp")
    .description("Run the TeamSync MCP server over stdio (for AI coding tools). Launch it in your clone.")
    .action(async () => {
    const { runMcpStdio } = await import("./mcp/server.js");
    await runMcpStdio();
});
program
    .command("serve")
    .description("Run the local team server: team registry + REST API + live events + dashboard. Works in any folder.")
    .option("-p, --port <port>", "HTTP port (default 4700)", "4700")
    .option("--host <addr>", "bind address (default 0.0.0.0 = LAN)")
    .option("--state <file>", "registry state file (default ./.teamsync-server.json)")
    .option("--no-discovery", "disable the UDP LAN beacon")
    .action(async (opts, command) => {
    const global = command.parent.opts();
    const ctx = ctxFor(global, "serve");
    const out = makeOutput(false); // long-running; human output only
    await runServe(ctx, out, {
        port: Number(opts.port),
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.state ? { state: opts.state } : {}),
        ...(opts.discovery === false ? { noDiscovery: true } : {}),
    });
});
const team = program.command("team").description("Create and manage teams on a local TeamSync server.");
function teamServerOption(cmd) {
    return cmd.option("--server <url>", "team server URL (default: last used, else http://localhost:4700)");
}
teamServerOption(team.command("list")).description("List teams on the server.").action(async (opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team list");
    await runTeamList(ctx, makeOutput(ctx.json), opts);
});
teamServerOption(team.command("info <name>")).description("Show one team's members and roles.").action(async (name, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team info");
    await runTeamInfo(ctx, makeOutput(ctx.json), name, opts);
});
team
    .command("create <name>")
    .description("Create a team; you become its admin. Prints the one-time join code.")
    .option("--server <url>", "team server URL")
    .action(async (name, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team create");
    await runTeamCreate(ctx, makeOutput(ctx.json), name, opts);
});
team
    .command("join <name>")
    .description("Join a team with its join code and your role.")
    .requiredOption("--role <role>", "your role in the team (e.g. frontend)")
    .requiredOption("--code <code>", "the team's join code (from the admin)")
    .option("--server <url>", "team server URL")
    .action(async (name, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team join");
    await runTeamJoin(ctx, makeOutput(ctx.json), name, opts);
});
team
    .command("leave <name>")
    .description("Leave a team (admins must delete the team instead).")
    .option("--server <url>", "team server URL")
    .action(async (name, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team leave");
    await runTeamLeave(ctx, makeOutput(ctx.json), name, opts);
});
team
    .command("code <name>")
    .description("Show the current join code (admin only, token from this machine).")
    .option("--server <url>", "team server URL")
    .action(async (name, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team code");
    await runTeamCode(ctx, makeOutput(ctx.json), name, opts);
});
team
    .command("rotate-code <name>")
    .description("Generate a new join code; the old one stops working (admin only).")
    .option("--server <url>", "team server URL")
    .action(async (name, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team rotate-code");
    await runTeamRotateCode(ctx, makeOutput(ctx.json), name, opts);
});
team
    .command("remove-member <name> <login>")
    .description("Remove a member from a team (admin only).")
    .option("--server <url>", "team server URL")
    .action(async (name, login, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team remove-member");
    await runTeamRemoveMember(ctx, makeOutput(ctx.json), name, login, opts);
});
team
    .command("repo <name> <owner/repo>")
    .description("Point a team at a GitHub repository; the dashboard then shows its PRs (admin only).")
    .option("--server <url>", "team server URL")
    .action(async (name, repository, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team repo");
    await runTeamRepo(ctx, makeOutput(ctx.json), name, repository, opts);
});
team
    .command("delete <name>")
    .description("Delete a team and its roster (admin only).")
    .option("--server <url>", "team server URL")
    .action(async (name, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team delete");
    await runTeamDelete(ctx, makeOutput(ctx.json), name, opts);
});
team
    .command("heartbeat <name>")
    .description("Tell the server you're active (updates your 'last seen' on the dashboard).")
    .option("--server <url>", "team server URL")
    .action(async (name, opts, command) => {
    const global = command.parent.parent.opts();
    const ctx = ctxFor(global, "team heartbeat");
    await runTeamHeartbeat(ctx, makeOutput(ctx.json), name, opts);
});
team
    .command("discover")
    .description("Find TeamSync servers broadcasting on the local network (UDP).")
    .action(async () => {
    await runTeamDiscover(makeOutput(false));
});
program.exitOverride();
try {
    await program.parseAsync(process.argv);
}
catch (err) {
    // commander routes --help/--version through exitOverride; those are successes.
    const code = err.code;
    if (code === "commander.helpDisplayed" ||
        code === "commander.version" ||
        code === "commander.help") {
        process.exit(ExitCode.OK);
    }
    if (code === "commander.missingMandatoryOptionValue" ||
        code === "commander.unknownOption" ||
        code === "commander.missingArgument" ||
        code === "commander.missingSubcommand" ||
        code === "commander.invalidArgument") {
        console.error(err.message);
        process.exit(ExitCode.USAGE);
    }
    fail(err);
}
