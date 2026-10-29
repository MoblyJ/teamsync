// First-run setup, run by npm automatically after install (postinstall):
//   gh not installed → confirm → sudo-install it (package manager detected)
//   gh installed, not logged in → run `gh auth login` (interactive)
//   everything ready → leave it be
// Safety rules:
// - never fails the npm install (all errors → guidance, exit 0)
// - interactive steps only when stdin/stdout are TTYs (CI is left alone)
// - opt out: TEAMSYNC_NO_SETUP=1
// - skipped when the package runs from its own dev repo (INIT_CWD == cwd)
import { run, executableName } from "../core/proc.js";
export function decideSetupAction(f) {
    if (f.disabledByEnv || f.isDevRepoInstall)
        return "skip";
    if (!f.ghInstalled)
        return f.interactive ? "install-gh" : "skip-noninteractive";
    if (!f.ghAuthenticated)
        return f.interactive ? "login" : "skip-noninteractive";
    return "done";
}
/** The sudo command that installs gh on this machine, or null (manual then). */
export function pickInstallCommand(platform = process.platform) {
    switch (platform) {
        case "linux":
            // Ordered by commonality; the first that exists is chosen by caller.
            return { sudo: true, file: "apt-get", args: ["install", "-y", "gh"], label: "apt-get" };
        case "darwin":
            // brew needs no sudo; installing brew itself is out of scope.
            return { sudo: false, file: "brew", args: ["install", "gh"], label: "brew" };
        case "win32":
            return { sudo: false, file: "winget", args: ["install", "--id", "GitHub.cli", "-e"], label: "winget" };
        default:
            return null;
    }
}
async function existsOnPath(file) {
    const probe = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [file] : ["-v", file];
    const res = await run(probe, args, { timeoutMs: 10_000 }).catch(() => null);
    return res?.ok === true;
}
async function isGhAuthenticated(ghPath) {
    const gh = executableName(ghPath ?? "gh");
    const res = await run(gh, ["auth", "status"], { timeoutMs: 15_000 }).catch(() => null);
    return res?.ok === true;
}
async function confirm(question) {
    const rl = (await import("node:readline/promises")).createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    }
    finally {
        rl.close();
    }
}
function manual(label) {
    console.log(`  Manual install: https://cli.github.com/`);
    if (label)
        console.log(`  (detected ${label} — a distro package may not exist; use the official repo then.)`);
}
export async function runPostinstall(opts = {}) {
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    const gh = executableName(opts.ghPath ?? "gh");
    const ghInstalled = await existsOnPath(gh);
    const ghAuthenticated = ghInstalled ? await isGhAuthenticated(opts.ghPath) : false;
    const isDevRepoInstall = process.env.INIT_CWD === process.cwd();
    const action = decideSetupAction({
        ghInstalled,
        ghAuthenticated,
        interactive,
        disabledByEnv: process.env.TEAMSYNC_NO_SETUP === "1",
        isDevRepoInstall,
    });
    switch (action) {
        case "skip":
            return;
        case "done":
            console.log("teamsync: gh is installed and authenticated — nothing to set up. Run `teamsync doctor` anytime.");
            return;
        case "skip-noninteractive":
            console.log("teamsync: first-run setup needs an interactive terminal; skipping.");
            console.log("  gh installed:", ghInstalled, "| logged in:", ghAuthenticated);
            if (!ghInstalled)
                manual(null);
            else
                console.log("  Log in with: gh auth login   (then: gh auth setup-git)");
            return;
        case "install-gh": {
            console.log("teamsync: GitHub CLI (`gh`) was not found. TeamSync needs it for login + GitHub API calls.");
            const ok = await confirm("Install it now? (may ask for your sudo/admin password)");
            if (!ok) {
                console.log("Skipped. Install it later: https://cli.github.com/  then run `teamsync login`.");
                return;
            }
            const platform = process.platform;
            const candidates = platform === "linux"
                ? [pickInstallCommand("linux"), { sudo: true, file: "apt", args: ["install", "-y", "gh"], label: "apt" }]
                : [pickInstallCommand(platform)];
            for (const cmd of candidates) {
                if (!(await existsOnPath(cmd.file)))
                    continue;
                console.log(`Installing gh via ${cmd.label}${cmd.sudo ? " (sudo password may be asked)" : ""}…`);
                const res = await run(cmd.sudo ? "sudo" : cmd.file, cmd.sudo ? [cmd.file, ...cmd.args] : cmd.args, { inheritStdio: true, timeoutMs: 10 * 60_000 }).catch(() => null);
                if (res?.ok)
                    break;
                console.log(`${cmd.label} attempt failed — trying next option…`);
            }
            const installedNow = await existsOnPath(gh);
            if (!installedNow) {
                manual(platform === "linux" ? "apt" : null);
                console.log("After installing, run: gh auth login && gh auth setup-git");
                return;
            }
            console.log("gh installed ✓ — now logging in…");
            await run(gh, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https"], {
                inheritStdio: true,
                timeoutMs: 10 * 60_000,
            });
            await run(gh, ["auth", "setup-git"], { timeoutMs: 30_000 }).catch(() => { });
            console.log("Done. Verify with `teamsync doctor`.");
            return;
        }
        case "login": {
            console.log("teamsync: gh is installed but not logged in. Starting GitHub login (browser/device flow)…");
            const ok = await confirm("Log in now?");
            if (!ok) {
                console.log("Skipped. Later: teamsync login");
                return;
            }
            await run(gh, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https"], {
                inheritStdio: true,
                timeoutMs: 10 * 60_000,
            });
            await run(gh, ["auth", "setup-git"], { timeoutMs: 30_000 }).catch(() => { });
            console.log("Done. Verify with `teamsync doctor`.");
            return;
        }
    }
}
