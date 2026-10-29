// Per-user local state (roles, clone paths). Stored in the platform user
// config dir — never committed, never contains tokens. Config lives in the
// repo and is shared; this file is the "me" complement to it.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRepositorySlug } from "./config.js";
/** Membership lookup for the clone the user is standing in. */
export function findMembership(state, repository, clonePath) {
    const direct = state.memberships[`${repository}::${clonePath}`];
    if (direct)
        return direct;
    // Tolerate legacy entries keyed by repository alone.
    const legacy = state.memberships[repository];
    if (legacy && legacy.clonePath === clonePath)
        return legacy;
    return null;
}
export function userStateDir(env = process.env) {
    if (env.TEAMSYNC_HOME)
        return env.TEAMSYNC_HOME;
    const platform = process.platform;
    if (platform === "win32") {
        return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "teamsync");
    }
    if (env.XDG_CONFIG_HOME)
        return path.join(env.XDG_CONFIG_HOME, "teamsync");
    return path.join(os.homedir(), ".config", "teamsync");
}
export function userStateFile(env = process.env) {
    return path.join(userStateDir(env), "state.json");
}
export async function loadUserState(env = process.env) {
    try {
        const raw = await readFile(userStateFile(env), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || typeof parsed.memberships !== "object" || parsed.memberships === null) {
            return { version: 1, memberships: {} };
        }
        const memberships = {};
        for (const [key, value] of Object.entries(parsed.memberships)) {
            const [repoKey] = key.includes("::") ? key.split("::") : [key];
            if (!parseRepositorySlug(repoKey ?? key))
                continue;
            const v = value;
            if (typeof v?.role === "string" &&
                typeof v?.clonePath === "string" &&
                typeof v?.joinedAt === "string") {
                memberships[key] = {
                    repository: repoKey ?? key,
                    role: v.role,
                    clonePath: v.clonePath,
                    joinedAt: v.joinedAt,
                };
            }
        }
        return {
            version: 1,
            memberships,
            ...(typeof parsed.server === "string" ? { server: parsed.server } : {}),
            ...(typeof parsed.teamAdminTokens === "object" && parsed.teamAdminTokens !== null
                ? {
                    teamAdminTokens: Object.fromEntries(Object.entries(parsed.teamAdminTokens).filter(([, v]) => typeof v === "string")),
                }
                : {}),
        };
    }
    catch {
        return { version: 1, memberships: {} };
    }
}
export async function saveMembership(membership, env = process.env) {
    const state = await loadUserState(env);
    state.memberships[`${membership.repository}::${membership.clonePath}`] = membership;
    const dir = userStateDir(env);
    await mkdir(dir, { recursive: true });
    await writeFile(userStateFile(env), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
export async function clearMembership(repository, env = process.env) {
    const state = await loadUserState(env);
    for (const key of Object.keys(state.memberships)) {
        if (key === repository || key.startsWith(`${repository}::`))
            delete state.memberships[key];
    }
    const dir = userStateDir(env);
    await mkdir(dir, { recursive: true });
    await writeFile(userStateFile(env), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
async function mutateState(env, fn) {
    const state = await loadUserState(env);
    fn(state);
    const dir = userStateDir(env);
    await mkdir(dir, { recursive: true });
    await writeFile(userStateFile(env), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
/** Remember the team server the user last talked to (next commands reuse it). */
export async function saveServer(serverUrl, env = process.env) {
    await mutateState(env, (s) => {
        s.server = serverUrl;
    });
}
export async function loadServer(env = process.env) {
    const state = await loadUserState(env);
    return state.server ?? null;
}
/** Store a team's admin token locally (only the creating machine ever has it). */
export async function saveTeamAdminToken(team, token, env = process.env) {
    await mutateState(env, (s) => {
        s.teamAdminTokens = s.teamAdminTokens ?? {};
        s.teamAdminTokens[team.toLowerCase()] = token;
    });
}
export async function loadTeamAdminToken(team, env = process.env) {
    const state = await loadUserState(env);
    return state.teamAdminTokens?.[team.toLowerCase()] ?? null;
}
