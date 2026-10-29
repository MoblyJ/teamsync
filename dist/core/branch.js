// Task branch naming: teamsync/<login>/<role>/<task-slug>-<suffix>
// Uniqueness contract: the suffix plus a remote-existence check guarantees we
// never propose a branch that already exists remotely (never reuse another
// person's branch, never reuse our own by accident).
import { randomBytes } from "node:crypto";
import { isValidBranchName, slugifyTaskName } from "./config.js";
export const BRANCH_PREFIX = "teamsync";
export function suffixFrom(seed) {
    // Deterministic when a seed is provided (tests); crypto-random otherwise.
    // Exactly 6 hex chars — parseTaskBranch depends on this shape.
    if (seed !== undefined)
        return seed.slice(0, 6).padEnd(6, "0");
    return randomBytes(3).toString("hex");
}
export function taskBranchName(parts) {
    return `${BRANCH_PREFIX}/${parts.login}/${parts.role}/${parts.taskSlug}-${parts.suffix}`;
}
/** Parse a branch name back into parts; null if not a teamsync task branch. */
export function parseTaskBranch(name) {
    const re = /^teamsync\/([^/]+)\/([^/]+)\/(.+)-([0-9a-f]{6})$/;
    const m = re.exec(name);
    if (!m)
        return null;
    return { login: m[1], role: m[2], task: m[3], suffix: m[4] };
}
export function isTeamsyncBranch(name) {
    return name.startsWith(`${BRANCH_PREFIX}/`);
}
/**
 * Build a task branch name for real use:
 * - slugifies the human task name,
 * - validates the final name against git's branch rules,
 * - throws (returns null) when impossible (e.g. login unsluggable).
 */
export function makeTaskBranch(login, role, task, suffix) {
    const cleanLogin = login
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 39);
    if (!cleanLogin)
        return null;
    const name = taskBranchName({ login: cleanLogin, role, taskSlug: slugifyTaskName(task), suffix: suffix ?? suffixFrom() });
    return isValidBranchName(name) ? name : null;
}
