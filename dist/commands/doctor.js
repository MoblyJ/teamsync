// `teamsync doctor` — diagnose the environment. Never installs anything; it
// explains what is missing and how to fix it. Every GitHub-side capability is
// discovered live, never assumed.
import { run, executableName } from "../core/proc.js";
import { GhNotInstalledError } from "../core/github.js";
import { GitClient } from "../core/git.js";
import { loadConfigFromDir, parseRepositorySlug } from "../core/config.js";
const GH = executableName("gh");
export async function runDoctor(ctx, out, opts) {
    const checks = [];
    const minNode = opts.minNodeMajor ?? 20;
    // Node runtime
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({
        name: "node",
        ok: nodeMajor >= minNode,
        severity: "critical",
        detail: `Node.js ${process.versions.node}${nodeMajor < minNode ? ` (need >= ${minNode})` : ""}`,
        hints: nodeMajor < minNode ? ["Install a supported Node.js LTS release from https://nodejs.org."] : [],
    });
    // Git
    try {
        const v = await new GitClient(process.cwd()).version();
        checks.push({ name: "git", ok: true, severity: "critical", detail: v, hints: [] });
    }
    catch (err) {
        checks.push({
            name: "git",
            ok: false,
            severity: "critical",
            detail: "git not found on PATH",
            hints: ["Install git: https://git-scm.com/downloads (Windows: winget install Git.Git, macOS: xcode-select --install)."],
        });
        void err;
    }
    // gh installed + authenticated
    let ghOk = false;
    try {
        const res = await run(executableName(ctx.ghPath ?? GH), ["--version"], { timeoutMs: 15_000 });
        ghOk = res.ok;
        checks.push({
            name: "gh",
            ok: ghOk,
            severity: "critical",
            detail: (res.stdout.split("\n")[0] ?? "gh").trim(),
            hints: [],
        });
    }
    catch {
        const e = new GhNotInstalledError();
        checks.push({ name: "gh", ok: false, severity: "critical", detail: e.message, hints: e.hints });
    }
    let login = null;
    if (ghOk) {
        try {
            const me = await ctx.adapter.whoAmI();
            login = me.login;
            checks.push({ name: "gh-auth", ok: true, severity: "critical", detail: `authenticated as ${me.login}`, hints: [] });
        }
        catch (err) {
            checks.push({
                name: "gh-auth",
                ok: false,
                severity: "critical",
                detail: err.message,
                hints: ["Run `teamsync login` (delegates to `gh auth login`)."],
            });
        }
    }
    // git credential helper for github.com (push/pull transport)
    if (ghOk) {
        const helper = await run(executableName("git"), ["config", "--get", "credential.https://github.com.helper"], {
            timeoutMs: 15_000,
        });
        const usesGh = /gh\s+auth|gh$/.test(helper.stdout.trim()) || helper.stdout.includes("gh auth");
        checks.push({
            name: "git-auth-transport",
            ok: usesGh,
            severity: "recommended",
            detail: usesGh ? "git uses gh as credential helper for github.com" : "git credential helper for github.com not set to gh",
            hints: usesGh ? [] : ["Run `gh auth setup-git` so git push/pull over HTTPS authenticates with your gh login."],
        });
    }
    // Repository-scoped checks (optional --repo, or derived from cwd).
    let repoSlug = opts.repo ?? null;
    if (!repoSlug) {
        try {
            const git = new GitClient(process.cwd());
            repoSlug = (await git.remoteSlug()) ?? null;
        }
        catch {
            repoSlug = null;
        }
        try {
            const cfg = await loadConfigFromDir(process.cwd());
            repoSlug = cfg.repository;
        }
        catch {
            // keep remote-derived slug
        }
    }
    if (repoSlug && parseRepositorySlug(repoSlug)) {
        if (!login) {
            checks.push({
                name: "repo-access",
                ok: false,
                severity: "recommended",
                detail: `${repoSlug}: skipped — login required first`,
                hints: [],
            });
        }
        else {
            const [owner, repo] = repoSlug.split("/");
            try {
                const info = await ctx.adapter.getRepo(owner, repo);
                checks.push({
                    name: "repo-access",
                    ok: info.viewerPermission !== "none" && info.viewerPermission !== "unknown",
                    severity: "critical",
                    detail: `${info.nameWithOwner} — your permission: ${info.viewerPermission}, default branch: ${info.defaultBranch}`,
                    hints: info.viewerPermission === "read" || info.viewerPermission === "triage"
                        ? ["Write access is needed to push task branches. Ask an admin to add you; `teamsync join` never grants access."]
                        : [],
                });
                checks.push({
                    name: "auto-merge-setting",
                    ok: info.allowAutoMerge,
                    severity: "recommended",
                    detail: info.allowAutoMerge
                        ? "repository allows auto-merge"
                        : "repository does NOT allow auto-merge (Settings → General → Pull Requests)",
                    hints: info.allowAutoMerge
                        ? []
                        : ["A repository admin must enable 'Allow auto-merge' once; without it, TeamSync uses manual merge mode."],
                });
                checks.push({
                    name: "actions",
                    ok: true,
                    severity: "recommended",
                    detail: await describeActions(ctx, owner, repo),
                    hints: [],
                });
                // Branch protection (readable only with admin/maintain; fine).
                const prot = await ctx.adapter.getBranchProtection(owner, repo, info.defaultBranch);
                const cfg = await tryLoadConfig(process.cwd());
                const requiredFromConfig = cfg?.checks.required ?? [];
                if (prot === null) {
                    checks.push({
                        name: "branch-protection",
                        ok: false,
                        severity: "recommended",
                        detail: "protection rules not readable without admin rights — cannot verify required checks",
                        hints: [
                            "An admin should enable protection on the default branch: require the 'integration' check and 'Require branches to be up to date before merging'.",
                        ],
                    });
                }
                else {
                    const missing = requiredFromConfig.filter((c) => !prot.requiredChecks.includes(c));
                    checks.push({
                        name: "branch-protection",
                        ok: prot.requiredChecks.length > 0,
                        severity: "recommended",
                        detail: `required checks: ${prot.requiredChecks.join(", ") || "none"}; up-to-date requirement: ${prot.requireUpToDateBranch}`,
                        hints: [
                            ...(prot.requiredChecks.length === 0 ? ["No required checks — automatic merging is NOT safe yet. An admin must require them."] : []),
                            ...missing.map((m) => `Config requires check "${m}" but protection does not list it — ask an admin to align them.`),
                        ],
                    });
                }
            }
            catch (err) {
                checks.push({
                    name: "repo-access",
                    ok: false,
                    severity: "critical",
                    detail: err.message,
                    hints: ["Verify the repository name and your access."],
                });
            }
        }
    }
    else {
        checks.push({
            name: "repo-access",
            ok: true,
            severity: "recommended",
            detail: "no repository context (run inside a clone or pass --repo OWNER/REPO)",
            hints: [],
        });
    }
    const healthy = checks.filter((c) => c.severity === "critical").every((c) => c.ok);
    if (!ctx.json)
        renderChecks(checks, out, healthy);
    return { checks, healthy };
}
async function describeActions(ctx, owner, repo) {
    // Discovering whether Actions is enabled: list workflows. 403/404 → likely disabled or restricted.
    const { ghApi } = await import("../core/github.js");
    try {
        const res = await ghApi(["api", `repos/${owner}/${repo}/actions/workflows`, "-F", "per_page=1"], { ghPath: ctx.ghPath });
        return `Actions enabled (${res.total_count} workflow(s) defined)`;
    }
    catch (err) {
        const msg = err.message;
        if (/403|404|refused/i.test(msg))
            return "Actions workflows not listable — Actions may be disabled, or you lack permission";
        return `Actions status unknown (${msg.slice(0, 80)})`;
    }
}
async function tryLoadConfig(dir) {
    const { loadConfigFromDir } = await import("../core/config.js");
    try {
        return await loadConfigFromDir(dir);
    }
    catch {
        return null;
    }
}
function renderChecks(checks, out, healthy) {
    out.say("");
    for (const c of checks) {
        const mark = c.ok ? "✓" : c.severity === "critical" ? "✗" : "!";
        const rendered = c.ok ? mark : mark;
        out.say(`${rendered} ${c.name}: ${c.detail}`);
        for (const h of c.hints)
            out.detail(`→ ${h}`);
    }
    out.say("");
    out.say(healthy ? "Critical requirements satisfied." : "Critical requirements missing — fix the ✗ items above.");
}
