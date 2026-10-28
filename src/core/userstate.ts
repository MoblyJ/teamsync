// Per-user local state (roles, clone paths). Stored in the platform user
// config dir — never committed, never contains tokens. Config lives in the
// repo and is shared; this file is the "me" complement to it.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRepositorySlug } from "./config.js";

export interface RepoMembership {
  repository: string; // OWNER/REPO
  role: string;
  clonePath: string;
  joinedAt: string; // ISO timestamp
}

export interface TeamsyncUserState {
  version: 1;
  /** Keyed by "OWNER/REPO::clonePath" — one person may keep several clones. */
  memberships: Record<string, RepoMembership>;
  /** Last-used team server URL (set by `team` commands). */
  server?: string;
  /** Admin tokens per team name — shown once by the server at creation. */
  teamAdminTokens?: Record<string, string>;
}

/** Membership lookup for the clone the user is standing in. */
export function findMembership(
  state: TeamsyncUserState,
  repository: string,
  clonePath: string,
): RepoMembership | null {
  const direct = state.memberships[`${repository}::${clonePath}`];
  if (direct) return direct;
  // Tolerate legacy entries keyed by repository alone.
  const legacy = state.memberships[repository];
  if (legacy && legacy.clonePath === clonePath) return legacy;
  return null;
}

export function userStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEAMSYNC_HOME) return env.TEAMSYNC_HOME;
  const platform = process.platform;
  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "teamsync");
  }
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "teamsync");
  return path.join(os.homedir(), ".config", "teamsync");
}

export function userStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(userStateDir(env), "state.json");
}

export async function loadUserState(env: NodeJS.ProcessEnv = process.env): Promise<TeamsyncUserState> {
  try {
    const raw = await readFile(userStateFile(env), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.memberships !== "object" || parsed.memberships === null) {
      return { version: 1, memberships: {} };
    }
    const memberships: Record<string, RepoMembership> = {};
    for (const [key, value] of Object.entries(parsed.memberships as Record<string, unknown>)) {
      const [repoKey] = key.includes("::") ? key.split("::") : [key];
      if (!parseRepositorySlug(repoKey ?? key)) continue;
      const v = value as Record<string, unknown>;
      if (
        typeof v?.role === "string" &&
        typeof v?.clonePath === "string" &&
        typeof v?.joinedAt === "string"
      ) {
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
            teamAdminTokens: Object.fromEntries(
              Object.entries(parsed.teamAdminTokens).filter(
                ([, v]) => typeof v === "string",
              ) as [string, string][],
            ),
          }
        : {}),
    };
  } catch {
    return { version: 1, memberships: {} };
  }
}

export async function saveMembership(
  membership: RepoMembership,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const state = await loadUserState(env);
  state.memberships[`${membership.repository}::${membership.clonePath}`] = membership;
  const dir = userStateDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(userStateFile(env), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearMembership(repository: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const state = await loadUserState(env);
  for (const key of Object.keys(state.memberships)) {
    if (key === repository || key.startsWith(`${repository}::`)) delete state.memberships[key];
  }
  const dir = userStateDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(userStateFile(env), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function mutateState(env: NodeJS.ProcessEnv, fn: (state: TeamsyncUserState) => void): Promise<void> {
  const state = await loadUserState(env);
  fn(state);
  const dir = userStateDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(userStateFile(env), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Remember the team server the user last talked to (next commands reuse it). */
export async function saveServer(serverUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mutateState(env, (s) => {
    s.server = serverUrl;
  });
}

export async function loadServer(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const state = await loadUserState(env);
  return state.server ?? null;
}

/** Store a team's admin token locally (only the creating machine ever has it). */
export async function saveTeamAdminToken(team: string, token: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mutateState(env, (s) => {
    s.teamAdminTokens = s.teamAdminTokens ?? {};
    s.teamAdminTokens[team.toLowerCase()] = token;
  });
}

export async function loadTeamAdminToken(team: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const state = await loadUserState(env);
  return state.teamAdminTokens?.[team.toLowerCase()] ?? null;
}
