// .teamsync/config.json — validated, versioned shared repository configuration.
// Lives in the repository (GitHub holds shared state). Contains no secrets.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { configError } from "./errors.js";
export const CONFIG_DIR = ".teamsync";
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
export const SUPPORTED_CONFIG_VERSION = 1;
/** Load + validate `.teamsync/config.json` from a worktree root. Throws ENOENT-style fs errors when absent. */
export async function loadConfigFromDir(repoRoot) {
    const file = path.join(repoRoot, CONFIG_PATH);
    const raw = await readFile(file, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw configError(`${CONFIG_PATH} is not valid JSON: ${err.message}`, [
            `Fix the JSON syntax in ${file}.`,
        ]);
    }
    return parseConfig(parsed, CONFIG_PATH);
}
/** Serialize a config object deterministically for writing into a repo. */
export function serializeConfig(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
}
export const DEFAULT_SHARED_PATHS = [
    "packages/contracts/**",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".github/workflows/**",
    ".teamsync/**",
];
export const DEFAULT_ROLES = {
    services: { paths: ["services/**"], description: "Integrations, external APIs, background jobs" },
    backend: { paths: ["apps/backend/**", "packages/contracts/**"], description: "API, database, business logic" },
    frontend: { paths: ["apps/frontend/**", "packages/contracts/**"], description: "User interface and API integration" },
    qa: { paths: ["tests/**", ".github/workflows/**"], description: "Tests, builds, cross-component validation" },
};
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const BRANCH_NAME_RE = /^(?!\/)(?!.*(\/\/|@\{|\\|\.\.| |\t|~|\^|\?|\*:|\[))[^\u0000-\u001f *?\\\u007f]+(?<!\/)(?<!\.lock)$/;
export function isValidBranchName(name) {
    return name.length > 0 && name.length <= 200 && BRANCH_NAME_RE.test(name);
}
export function isValidRoleName(name) {
    return SLUG_RE.test(name);
}
/** "owner/repo" with GitHub's relaxed repo name rules; no whitespace, no "..". */
export function parseRepositorySlug(input) {
    const m = /^([A-Za-z0-9][A-Za-z0-9-._]{0,100})\/([A-Za-z0-9][A-Za-z0-9-._]{0,100})$/.exec(input.trim());
    if (!m)
        return null;
    const [, owner, repo] = m;
    if (input.includes("..") || repo === "." || repo === "..")
        return null;
    return { owner: owner, repo: repo };
}
export function slugifyTaskName(task) {
    return (task
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "") // strip combining marks after NFKD
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-")
        .slice(0, 40) || "task");
}
function asArray(v, what) {
    if (!Array.isArray(v))
        throw configError(`\`config ${what}\` must be an array of strings.`);
    return v.map((item) => {
        if (typeof item !== "string")
            throw configError(`\`config ${what}\` must contain only strings.`);
        validatePathPattern(item, what);
        return item;
    });
}
/** Patterns must be repo-relative, may not escape the repository, may not be absolute. */
export function validatePathPattern(pattern, context) {
    if (pattern.length === 0)
        throw configError(`Empty path pattern in ${context}.`);
    if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern)) {
        throw configError(`Path pattern "${pattern}" in ${context} is absolute. Use repository-relative paths like "apps/frontend/**".`, ["Edit .teamsync/config.json and replace absolute paths with repository-relative ones."]);
    }
    const parts = pattern.split(/[\\/]/);
    if (parts.includes("..")) {
        throw configError(`Path pattern "${pattern}" in ${context} escapes the repository (".."). Refusing to trust it.`, ["Edit .teamsync/config.json to remove parent-directory traversal."]);
    }
    if (pattern.includes("\u0000")) {
        throw configError(`Path pattern in ${context} contains a NUL byte.`);
    }
}
/**
 * Validate untrusted JSON into a TeamsyncConfig. Throws configError with
 * actionable hints on any problem. Never trusts file contents.
 */
export function parseConfig(raw, source = CONFIG_PATH) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw configError(`${source} must contain a JSON object.`);
    }
    const obj = raw;
    if (obj.version === undefined) {
        throw configError(`${source} is missing "version".`, [
            `Add "version": ${SUPPORTED_CONFIG_VERSION} or re-run \`teamsync init\` to regenerate.`,
        ]);
    }
    if (typeof obj.version !== "number" || !Number.isInteger(obj.version)) {
        throw configError(`${source} has a non-integer "version".`);
    }
    if (obj.version > SUPPORTED_CONFIG_VERSION) {
        throw configError(`${source} uses config version ${obj.version}, but this CLI supports at most ${SUPPORTED_CONFIG_VERSION}. Update the CLI.`, ["npm install -g @teamsync/teamsync@latest"]);
    }
    if (obj.version < SUPPORTED_CONFIG_VERSION) {
        throw configError(`${source} uses config version ${obj.version}, which is no longer supported. Re-run \`teamsync init\` in a clone to regenerate it.`);
    }
    const repository = obj.repository;
    if (typeof repository !== "string" || !parseRepositorySlug(repository)) {
        throw configError(`${source} has an invalid "repository"; expected "OWNER/REPO".`);
    }
    const defaultBranch = obj.defaultBranch;
    if (typeof defaultBranch !== "string" || !isValidBranchName(defaultBranch)) {
        throw configError(`${source} has an invalid "defaultBranch": ${JSON.stringify(defaultBranch)}.`);
    }
    let roles;
    if (obj.roles === undefined || obj.roles === null) {
        roles = structuredClone(DEFAULT_ROLES);
    }
    else {
        if (typeof obj.roles !== "object" || Array.isArray(obj.roles)) {
            throw configError(`${source} "roles" must be an object mapping role name to {paths}.`);
        }
        roles = {};
        for (const [name, value] of Object.entries(obj.roles)) {
            if (!isValidRoleName(name)) {
                throw configError(`${source} has an invalid role name "${name}". Use lowercase letters, digits, dot, dash, underscore (max 63).`);
            }
            if (typeof value !== "object" || value === null) {
                throw configError(`${source} role "${name}" must be an object.`);
            }
            const rv = value;
            const paths = asArray(rv.paths ?? [], `roles.${name}.paths`);
            if (paths.length === 0) {
                throw configError(`${source} role "${name}" has an empty "paths" list.`);
            }
            roles[name] = {
                paths,
                ...(rv.description !== undefined
                    ? { description: typeof rv.description === "string" ? rv.description : undefined }
                    : {}),
            };
        }
        if (Object.keys(roles).length === 0) {
            throw configError(`${source} defines zero roles; add at least one role or remove "roles" to use defaults.`);
        }
    }
    const sharedPaths = obj.sharedPaths === undefined ? [...DEFAULT_SHARED_PATHS] : asArray(obj.sharedPaths, "sharedPaths");
    let checks = { required: [] };
    if (obj.checks !== undefined) {
        if (typeof obj.checks !== "object" || obj.checks === null) {
            throw configError(`${source} "checks" must be an object with a "required" array.`);
        }
        const required = asArray(obj.checks.required ?? [], "checks.required");
        checks = { required };
    }
    let mergePolicy = { method: "squash", autoMerge: true, deleteBranchOnMerge: true };
    if (obj.mergePolicy !== undefined) {
        if (typeof obj.mergePolicy !== "object" || obj.mergePolicy === null) {
            throw configError(`${source} "mergePolicy" must be an object.`);
        }
        const mp = obj.mergePolicy;
        const method = mp.method ?? "squash";
        if (method !== "merge" && method !== "squash" && method !== "rebase") {
            throw configError(`${source} mergePolicy.method must be one of "merge" | "squash" | "rebase".`);
        }
        for (const flag of ["autoMerge", "deleteBranchOnMerge"]) {
            if (mp[flag] !== undefined && typeof mp[flag] !== "boolean") {
                throw configError(`${source} mergePolicy.${flag} must be a boolean.`);
            }
        }
        mergePolicy = {
            method,
            autoMerge: mp.autoMerge === undefined ? true : mp.autoMerge,
            deleteBranchOnMerge: mp.deleteBranchOnMerge === undefined ? true : mp.deleteBranchOnMerge,
        };
    }
    return {
        version: obj.version,
        repository,
        defaultBranch,
        roles,
        sharedPaths,
        checks,
        mergePolicy,
        ...(typeof obj.createdBy === "string" ? { createdBy: obj.createdBy } : {}),
    };
}
/** The role definition for a role name, or null if the config doesn't define it. */
export function roleOr(config, role) {
    return config.roles[role] ?? null;
}
export function classifyPath(config, role, repoRelativePath) {
    const posix = repoRelativePath.replace(/\\/g, "/");
    const shared = config.sharedPaths.some((p) => globMatch(p, posix));
    if (shared)
        return "shared";
    const rc = config.roles[role];
    if (!rc)
        return "unowned";
    if (rc.paths.some((p) => globMatch(p, posix)))
        return "role";
    // A path no role claims.
    const claimedByAny = Object.values(config.roles).some((r) => r.paths.some((p) => globMatch(p, posix)));
    return claimedByAny ? "outside-role" : "unowned";
}
/** Minimal glob: ** crosses directories, * within a segment, ? one char. */
export function globMatch(pattern, path) {
    const re = globToRegExp(pattern);
    return re.test(path);
}
export function globToRegExp(pattern) {
    let out = "^";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "*" && pattern[i + 1] === "*") {
            // "**" — swallow the preceding slash, match across directories (or nothing).
            if (out.endsWith("/"))
                out = out.slice(0, -1);
            out += "(?:/.*)?";
            i += 1; // second '*' consumed by loop advance; a following '/' stays literal
        }
        else if (c === "*") {
            out += "[^/]*";
        }
        else if (c === "?") {
            out += "[^/]";
        }
        else if ("\\^$.|+()[]{}".includes(c)) {
            out += `\\${c}`;
        }
        else {
            out += c;
        }
    }
    return new RegExp(`${out}$`);
}
