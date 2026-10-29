// `teamsync login` — delegates entirely to `gh auth login` (browser/device
// flow handled by gh). We never see, store, or log the token. Verifies the
// result and makes sure git over HTTPS can authenticate too.
import { run, executableName } from "../core/proc.js";
import { authError, TeamsyncError, ExitCode } from "../core/errors.js";
import { redact } from "../core/redact.js";
export async function runLogin(ctx, out) {
    out.say("Opening the GitHub login flow via GitHub CLI (gh)…");
    out.detail("A browser window or device code will be used; the token stays inside gh's secure storage.");
    out.detail("TeamSync never sees or stores your credentials.");
    const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!isTTY) {
        throw authError("`teamsync login` needs an interactive terminal to run `gh auth login`.", [
            "Open a normal terminal and run: gh auth login   (or `! gh auth login` from a shell prompt).",
            "Noninteractive environments: set GH_TOKEN in the environment instead — the adapter picks it up.",
        ]);
    }
    const res = await run(executableName(ctx.ghPath ?? "gh"), ["auth", "login", "--hostname", "github.com", "--git-protocol", "https"], {
        inheritStdio: true,
        timeoutMs: 10 * 60_000,
    });
    if (!res.ok) {
        throw new TeamsyncError({
            message: "GitHub login did not complete.",
            code: "login-failed",
            exitCode: ExitCode.AUTH,
            hints: ["Run `gh auth login` directly to see the interactive prompts.", "Cancel and retry if the browser did not open."],
        });
    }
    // Verify identity without printing any token material.
    const me = await ctx.adapter.whoAmI().catch((err) => {
        throw new TeamsyncError({
            message: `Login finished, but verifying identity failed: ${err.message}`,
            code: "login-verify",
            exitCode: ExitCode.AUTH,
            hints: ["Check `gh auth status` for details.", redact(err.message)],
        });
    });
    // Make git-over-HTTPS use gh's credential helper (idempotent, safe).
    await run(executableName(ctx.ghPath ?? "gh"), ["auth", "setup-git"], { timeoutMs: 30_000 });
    out.success(`Logged in as ${me.login}.`);
    out.detail("Git push/pull over HTTPS now authenticates through gh (via `gh auth setup-git`).");
    ctx.events.emit({ ts: new Date().toISOString(), type: "command.end", data: { login: me.login } });
}
