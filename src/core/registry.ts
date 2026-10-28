// Team registry: pure state machine for teams, admins, members, and join
// codes. No I/O — the HTTP server and CLI both sit on top of these
// functions, so every rule (admin rights, join codes, idempotency) is
// unit-testable and identical everywhere.
//
// Trust model (documented, deliberate): identity is a claimed GitHub login
// verified only by possession of a join code (membership) or the admin token
// (admin operations). This is a LAN-trust coordination server, not an auth
// provider — it never touches GitHub credentials.
import { randomBytes } from "node:crypto";
import { blockedError, notFoundError, usageError } from "./errors.js";
import { parseRepositorySlug } from "./config.js";

export interface RegistryMember {
  login: string;
  role: string;
  clonePath?: string;
  joinedAt: string;
  lastSeen?: string;
}

export interface RegistryTeam {
  id: string;
  name: string; // canonical (lowercase)
  displayName: string; // as typed by the creator
  admin: string; // GitHub login of the creator
  joinCode: string;
  adminToken: string;
  createdAt: string;
  repository?: string; // OWNER/REPO this team works on (for the dashboard)
  members: Record<string, RegistryMember>; // keyed by login
}

export interface Registry {
  version: 1;
  teams: Record<string, RegistryTeam>; // keyed by lowercase name
}

export function emptyRegistry(): Registry {
  return { version: 1, teams: {} };
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const ROLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Unambiguous alphabet (no 0/O/1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function canonicalTeamName(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidTeamName(input: string): boolean {
  return NAME_RE.test(canonicalTeamName(input));
}

export function isValidRole(input: string): boolean {
  return ROLE_RE.test(input);
}

function newJoinCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function requireTeam(registry: Registry, name: string): RegistryTeam {
  const team = registry.teams[canonicalTeamName(name)];
  if (!team) {
    throw notFoundError(`Team "${name}" does not exist on this server.`, [
      "Check the name, or list teams with `teamsync team list`.",
      "Create it with `teamsync team create <name>`.",
    ]);
  }
  return team;
}

function requireAdmin(team: RegistryTeam, adminToken: string): void {
  if (adminToken !== team.adminToken) {
    throw blockedError(`Not the admin of team "${team.displayName}".`, [
      "Only the teammate who created the team can perform admin actions.",
      "The admin token is shown once when the team is created.",
    ]);
  }
}

export interface CreateTeamInput {
  name: string;
  adminLogin: string;
  now?: string;
}

export interface CreateTeamResult {
  team: RegistryTeam;
  /** Shown ONCE: the join code is the membership gate. */
  joinCode: string;
  adminToken: string;
}

export function createTeam(registry: Registry, input: CreateTeamInput): CreateTeamResult {
  if (!isValidTeamName(input.name)) {
    throw usageError(
      `Invalid team name "${input.name}" — use 3-40 chars: letters, digits, dot, dash, underscore.`,
      [],
    );
  }
  const canonical = canonicalTeamName(input.name);
  if (registry.teams[canonical]) {
    throw blockedError(`Team "${input.name}" already exists on this server.`, [
      "Pick another name, or join it with `teamsync team join " + canonical + "`.",
    ]);
  }
  if (!input.adminLogin || /[^A-Za-z0-9-]/.test(input.adminLogin)) {
    throw usageError("A valid GitHub login is required to create a team.");
  }
  const now = input.now ?? new Date().toISOString();
  const team: RegistryTeam = {
    id: `t_${randomBytes(6).toString("hex")}`,
    name: canonical,
    displayName: input.name.trim(),
    admin: input.adminLogin,
    joinCode: newJoinCode(),
    adminToken: randomBytes(24).toString("hex"),
    createdAt: now,
    members: {
      [input.adminLogin]: { login: input.adminLogin, role: "admin", joinedAt: now },
    },
  };
  registry.teams[canonical] = team;
  return { team, joinCode: team.joinCode, adminToken: team.adminToken };
}

export function joinTeam(
  registry: Registry,
  input: { name: string; login: string; role: string; joinCode: string; clonePath?: string; now?: string },
): RegistryTeam {
  const team = requireTeam(registry, input.name);
  if (input.joinCode.trim().toUpperCase() !== team.joinCode) {
    throw blockedError(`Wrong join code for team "${team.displayName}".`, [
      "Ask the team admin for the current code (they can show it with `teamsync team code <name>`).",
    ]);
  }
  if (!isValidRole(input.role)) {
    throw usageError(`Invalid role "${input.role}" — lowercase letters, digits, dot, dash, underscore (max 64).`);
  }
  const now = input.now ?? new Date().toISOString();
  const existing = team.members[input.login];
  team.members[input.login] = {
    login: input.login,
    role: input.role,
    joinedAt: existing?.joinedAt ?? now,
    lastSeen: now,
    ...(existing?.clonePath !== undefined && input.clonePath === undefined
      ? { clonePath: existing.clonePath }
      : {}),
    ...(input.clonePath !== undefined ? { clonePath: input.clonePath } : {}),
  };
  return team;
}

export function leaveTeam(registry: Registry, input: { name: string; login: string }): RegistryTeam {
  const team = requireTeam(registry, input.name);
  if (!team.members[input.login]) {
    throw notFoundError(`"${input.login}" is not a member of "${team.displayName}".`);
  }
  if (input.login === team.admin) {
    throw blockedError(`The team admin cannot leave team "${team.displayName}".`, [
      "Delete the team instead: `teamsync team delete " + team.name + "` (requires the admin token).",
    ]);
  }
  delete team.members[input.login];
  return team;
}

export function heartbeat(
  registry: Registry,
  input: { name: string; login: string; branch?: string; now?: string },
): RegistryTeam {
  const team = requireTeam(registry, input.name);
  const member = team.members[input.login];
  if (!member) {
    throw notFoundError(`"${input.login}" is not a member of "${team.displayName}".`, [
      "Join first: `teamsync team join " + team.name + " --role <role>`.",
    ]);
  }
  member.lastSeen = input.now ?? new Date().toISOString();
  void input.branch; // reserved for richer dashboards
  return team;
}

export function removeMember(
  registry: Registry,
  input: { name: string; login: string; adminToken: string },
): RegistryTeam {
  const team = requireTeam(registry, input.name);
  requireAdmin(team, input.adminToken);
  if (input.login === team.admin) {
    throw usageError("The admin cannot remove themselves; delete the team instead.");
  }
  if (!team.members[input.login]) {
    throw notFoundError(`"${input.login}" is not a member of "${team.displayName}".`);
  }
  delete team.members[input.login];
  return team;
}

export function deleteTeam(registry: Registry, input: { name: string; adminToken: string }): void {
  const team = requireTeam(registry, input.name);
  requireAdmin(team, input.adminToken);
  delete registry.teams[team.name];
}

export function regenerateJoinCode(
  registry: Registry,
  input: { name: string; adminToken: string },
): string {
  const team = requireTeam(registry, input.name);
  requireAdmin(team, input.adminToken);
  team.joinCode = newJoinCode();
  return team.joinCode;
}

export function showJoinCode(registry: Registry, input: { name: string; adminToken: string }): string {
  const team = requireTeam(registry, input.name);
  requireAdmin(team, input.adminToken);
  return team.joinCode;
}

export function setTeamRepository(
  registry: Registry,
  input: { name: string; repository: string; adminToken: string },
): RegistryTeam {
  const team = requireTeam(registry, input.name);
  requireAdmin(team, input.adminToken);
  if (!parseRepositorySlug(input.repository)) {
    throw usageError(`Invalid repository "${input.repository}" — expected OWNER/REPO.`);
  }
  team.repository = input.repository.trim();
  return team;
}

/** Public projection of a team (never leaks joinCode/adminToken). */
export function publicTeam(team: RegistryTeam): {
  name: string;
  displayName: string;
  admin: string;
  createdAt: string;
  repository?: string;
  memberCount: number;
  members: Array<{ login: string; role: string; joinedAt: string; lastSeen?: string }>;
} {
  return {
    name: team.name,
    displayName: team.displayName,
    admin: team.admin,
    createdAt: team.createdAt,
    ...(team.repository !== undefined ? { repository: team.repository } : {}),
    memberCount: Object.keys(team.members).length,
    members: Object.values(team.members)
      .map((m) => ({
        login: m.login,
        role: m.role,
        joinedAt: m.joinedAt,
        ...(m.lastSeen !== undefined ? { lastSeen: m.lastSeen } : {}),
      }))
      .sort((a, b) => (a.login < b.login ? -1 : 1)),
  };
}
