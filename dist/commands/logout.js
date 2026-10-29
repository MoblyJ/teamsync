// `teamsync logout` — removes the gh login after an explicit confirmation,
// because that login is shared with every other gh-based tool on the machine.
import { run, executableName } from "../core/proc.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TeamsyncError, ExitCode } from "../core/errors.js";
async function confirm(question) {
    if (process.stdin.isTTY !== true)
        return false;
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        const answer = await rl.question(`${question} `);
        return /^y(es)?$/i.test(answer.trim());
    }
    finally {
        rl.close();
    }
}
export async function runLogout(ctx, out, opts) {
    const me = await ctx.adapter.whoAmI().catch(() => null);
    if (!me) {
        out.say("No active GitHub login found (gh is not authenticated). Nothing to do.");
        return;
    }
    out.warn("The gh login is shared with every other tool that uses the GitHub CLI on this machine (scripts, editors, other CLIs).");
    if (opts.yes !== true) {
        const ok = await confirm(`Log out ${me.login} for ALL of them? [y/N]`);
        if (!ok) {
            out.say("Aborted — login left in place.");
            return;
        }
    }
    const res = await run(executableName(ctx.ghPath ?? "gh"), ["auth", "logout", "--hostname", "github.com"], {
        inheritStdio: true,
        timeoutMs: 60_000,
    });
    if (!res.ok) {
        throw new TeamsyncError({
            message: "gh auth logout failed.",
            code: "logout-failed",
            exitCode: ExitCode.GENERAL,
            hints: ["Run `gh auth logout` manually and follow its prompts."],
        });
    }
    out.success(`Logged out ${me.login}. Other tools that relied on this gh login will need to log in again.`);
}
