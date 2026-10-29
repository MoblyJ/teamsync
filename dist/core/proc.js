// Subprocess execution. Rules enforced here:
// - Always spawn with an argument array; never interpolate a shell command.
//   The only shell:true case is a Windows .cmd/.bat shim, and even then the
//   command line is built with explicit quoting, never string interpolation
//   of user input alone.
// - Bounded timeout on every call.
// - Tokens are NEVER logged; any child stderr we surface goes through the
//   redactor first (see core/redact.ts). We deliberately keep GH_TOKEN /
//   GITHUB_TOKEN in the child environment: that is how `gh` authenticates in
//   CI, and stripping it would break running the CLI inside GitHub Actions.
import { spawn } from "node:child_process";
export class ProcessError extends Error {
    result;
    command;
    constructor(message, result, command) {
        super(message);
        this.result = result;
        this.command = command;
        this.name = "ProcessError";
    }
}
/**
 * Resolve the executable name per platform. On Windows, gh ships as gh.exe
 * and npm shims are .cmd; Node's spawn with shell:false needs exact names.
 * Explicit paths/extensions are respected as-is.
 */
export function executableName(base, platform = process.platform) {
    if (platform !== "win32")
        return base;
    if (/\.(exe|cmd|bat|ps1)$/i.test(base) || base.includes("/") || base.includes("\\"))
        return base;
    return `${base}.exe`;
}
/** True when spawning this file on this platform requires going through the shell. */
export function needsShell(file, platform = process.platform) {
    if (platform !== "win32")
        return false;
    const lower = file.toLowerCase();
    return lower.endsWith(".cmd") || lower.endsWith(".bat");
}
/** Build a safely-quoted command line for the rare shell:true Windows case. */
export function quoteForShell(args) {
    return args
        .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
        .join(" ");
}
/**
 * Environment policy for child processes. Currently a pass-through: tokens
 * must reach gh (CI auth), and secrets in output are handled by redaction.
 * Kept as a named seam so a stricter policy can be applied in one place.
 */
export function childEnv(env = process.env) {
    return { ...env };
}
export async function run(file, args, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const useShell = needsShell(file, process.platform);
    // shell:true path passes a single pre-quoted string; shell:false path
    // passes the raw argument array (no shell interpretation anywhere).
    const spawnArgs = useShell ? [quoteForShell([file, ...args])] : [...args];
    const spawnFile = useShell ? (process.env.ComSpec ?? "cmd.exe") : file;
    return new Promise((resolve, reject) => {
        const child = spawn(spawnFile, spawnArgs, {
            cwd: opts.cwd,
            env: childEnv(opts.env),
            shell: false,
            windowsHide: true,
            stdio: opts.inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            fn();
        };
        if (!opts.inheritStdio) {
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (d) => {
                stdout += d;
            });
            child.stderr.on("data", (d) => {
                stderr += d;
            });
        }
        if (opts.signal) {
            const onAbort = () => {
                try {
                    child.kill("SIGINT");
                }
                catch {
                    /* already gone */
                }
            };
            if (opts.signal.aborted)
                onAbort();
            else
                opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        timer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            }
            catch {
                /* already gone */
            }
            finish(() => reject(new ProcessError(`Command timed out after ${timeoutMs}ms: ${file}`, { ok: false, exitCode: null, stdout, stderr, signal: "SIGKILL" }, [file, ...args])));
        }, timeoutMs);
        child.on("error", (err) => {
            finish(() => reject(new ProcessError(err.message, { ok: false, exitCode: null, stdout, stderr, signal: null }, [file, ...args])));
        });
        child.on("close", (code, signal) => {
            finish(() => resolve({ ok: code === 0, exitCode: code, stdout, stderr, signal }));
        });
        if (!opts.inheritStdio) {
            if (opts.input !== undefined)
                child.stdin.end(opts.input);
            else
                child.stdin.end();
        }
    });
}
