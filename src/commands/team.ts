// `teamsync team …` — create/join/manage teams on a local TeamSync server.
// Identity = your GitHub login (via gh, real or fake in dev). Membership is
// gated by a join code; admin rights by the admin token issued at creation
// and stored only on the creator's machine.
import { apiFetch } from "../core/netclient.js";
import {
  loadServer,
  loadTeamAdminToken,
  saveServer,
  saveTeamAdminToken,
} from "../core/userstate.js";
import { usageError, blockedError } from "../core/errors.js";
import { isValidRole, isValidTeamName } from "../core/registry.js";
import { discoverServers } from "../server/discovery.js";
import type { Output } from "../ui/output.js";
import type { CommandContext } from "./context.js";

export interface TeamOptions {
  server?: string;
  role?: string;
  code?: string;
  login?: string; // override identity (dev/testing only)
  timeoutMs?: number;
}

interface PublicTeam {
  name: string;
  displayName: string;
  admin: string;
  createdAt: string;
  repository?: string;
  memberCount: number;
  members: Array<{ login: string; role: string; joinedAt: string; lastSeen?: string }>;
}

async function resolveServer(opts: TeamOptions): Promise<string> {
  const url =
    process.env.TEAMSYNC_SERVER ??
    opts.server ??
    (await loadServer()) ??
    "http://localhost:4700";
  const normalized = url.endsWith("/") ? url.slice(0, -1) : url;
  await saveServer(normalized);
  return normalized;
}

async function identity(ctx: CommandContext, opts: TeamOptions): Promise<string> {
  if (opts.login) return opts.login;
  const me = await ctx.adapter.whoAmI();
  return me.login;
}

function printTeam(out: Output, team: PublicTeam, viewer: string): void {
  out.say(`${team.displayName} — admin: ${team.admin} · ${team.memberCount} member(s)`);
  for (const m of team.members) {
    const mark = m.login === team.admin ? "★" : m.login === viewer ? "•" : " ";
    const seen = m.lastSeen ? ` · seen ${m.lastSeen}` : "";
    out.say(` ${mark} ${m.login.padEnd(16)} ${m.role}${seen}`);
  }
  if (team.repository) out.detail(`repository: ${team.repository}`);
}

export async function runTeamList(ctx: CommandContext, out: Output, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const { body } = await apiFetch<{ teams: PublicTeam[] }>(server, "/api/teams", { timeoutMs: opts.timeoutMs });
  out.say(`Teams on ${server}:`);
  if (body.teams.length === 0) out.list(["none yet — create one with `teamsync team create <name>`"]);
  for (const t of body.teams) {
    out.say(`  ${t.displayName.padEnd(16)} ${String(t.memberCount).padStart(2)} member(s)  admin ${t.admin}`);
  }
}

export async function runTeamCreate(ctx: CommandContext, out: Output, name: string, opts: TeamOptions): Promise<void> {
  if (!isValidTeamName(name)) {
    throw usageError(`Invalid team name "${name}" — 3-40 chars: letters, digits, dot, dash, underscore.`);
  }
  const server = await resolveServer(opts);
  const login = await identity(ctx, opts);
  const { body } = await apiFetch<{ team: PublicTeam; joinCode: string; adminToken: string }>(server, "/api/teams", {
    method: "POST",
    body: { name, adminLogin: login },
  });
  await saveTeamAdminToken(body.team.name, body.adminToken);
  out.success(`Team "${body.team.displayName}" created on ${server} — you are the admin.`);
  out.say("");
  out.say("Share this with teammates (they must already have the CLI installed):");
  out.list([
    `teamsync team join ${body.team.name} --role <role> --code ${body.joinCode} --server ${server}`,
  ]);
  out.say("");
  out.warn("The join code is shown ONCE here. Retrieve it later with `teamsync team code " + body.team.name + "` (admin only).");
  out.warn("Admin actions (remove member, rotate code, delete, set repo) use the admin token stored on this machine.");
  if (ctx.json) out.json(body.team);
}

export async function runTeamJoin(ctx: CommandContext, out: Output, name: string, opts: TeamOptions): Promise<void> {
  const role = opts.role ?? "";
  if (!isValidRole(role)) {
    throw usageError("A role is required: --role <role> (e.g. frontend, backend, services, qa).");
  }
  if (!opts.code) {
    throw usageError("The join code is required: --code <CODE> (ask the team admin).");
  }
  const server = await resolveServer(opts);
  const login = await identity(ctx, opts);
  const { body } = await apiFetch<{ team: PublicTeam }>(server, `/api/teams/${encodeURIComponent(name)}/join`, {
    method: "POST",
    body: { login, role, joinCode: opts.code, clonePath: process.cwd() },
  });
  out.success(`Joined "${body.team.displayName}" as ${login} (${role}).`);
  printTeam(out, body.team, login);
  if (ctx.json) out.json(body.team);
}

export async function runTeamInfo(ctx: CommandContext, out: Output, name: string, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const login = await identity(ctx, opts);
  const { body } = await apiFetch<{ team: PublicTeam }>(server, `/api/teams/${encodeURIComponent(name)}`);
  printTeam(out, body.team, login);
  if (ctx.json) out.json(body.team);
}

export async function runTeamLeave(ctx: CommandContext, out: Output, name: string, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const login = await identity(ctx, opts);
  await apiFetch(server, `/api/teams/${encodeURIComponent(name)}/leave`, { method: "POST", body: { login } });
  out.success(`Left team "${name}" on ${server}.`);
}

export async function runTeamCode(ctx: CommandContext, out: Output, name: string, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const token = await loadTeamAdminToken(name);
  if (!token) {
    throw blockedError(`No admin token for "${name}" on this machine — only the creator can read the code.`, []);
  }
  const { body } = await apiFetch<{ joinCode: string }>(server, `/api/teams/${encodeURIComponent(name)}/show-code`, {
    method: "POST",
    body: { adminToken: token },
  });
  out.say(`Join code for "${name}": ${body.joinCode}`);
  out.detail(`Teammates join with: teamsync team join ${name} --role <role> --code ${body.joinCode} --server ${server}`);
}

export async function runTeamRotateCode(ctx: CommandContext, out: Output, name: string, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const token = await loadTeamAdminToken(name);
  if (!token) throw blockedError(`No admin token for "${name}" on this machine.`, []);
  const { body } = await apiFetch<{ joinCode: string }>(server, `/api/teams/${encodeURIComponent(name)}/code`, {
    method: "POST",
    body: { adminToken: token },
  });
  out.success(`New join code for "${name}": ${body.joinCode} (old code no longer works).`);
}

export async function runTeamRemoveMember(ctx: CommandContext, out: Output, name: string, memberLogin: string, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const token = await loadTeamAdminToken(name);
  if (!token) throw blockedError(`No admin token for "${name}" on this machine — only the creator can remove members.`, []);
  const { body } = await apiFetch<{ team: PublicTeam }>(server, `/api/teams/${encodeURIComponent(name)}/remove-member`, {
    method: "POST",
    body: { login: memberLogin, adminToken: token },
  });
  out.success(`Removed ${memberLogin} from "${body.team.displayName}".`);
}

export async function runTeamDelete(ctx: CommandContext, out: Output, name: string, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const token = await loadTeamAdminToken(name);
  if (!token) throw blockedError(`No admin token for "${name}" on this machine — only the creator can delete it.`, []);
  await apiFetch(server, `/api/teams/${encodeURIComponent(name)}`, { method: "DELETE", body: { adminToken: token } });
  out.success(`Deleted team "${name}" from ${server}.`);
}

export async function runTeamRepo(ctx: CommandContext, out: Output, name: string, repository: string, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const token = await loadTeamAdminToken(name);
  if (!token) throw blockedError(`No admin token for "${name}" on this machine.`, []);
  const { body } = await apiFetch<{ team: PublicTeam }>(server, `/api/teams/${encodeURIComponent(name)}/repository`, {
    method: "POST",
    body: { repository, adminToken: token },
  });
  out.success(`Team "${body.team.displayName}" now tracks ${repository}.`);
  out.detail(`The dashboard at ${server} shows this team's open PRs and their states.`);
}

export async function runTeamHeartbeat(ctx: CommandContext, out: Output, name: string, opts: TeamOptions): Promise<void> {
  const server = await resolveServer(opts);
  const login = await identity(ctx, opts);
  await apiFetch(server, `/api/teams/${encodeURIComponent(name)}/heartbeat`, {
    method: "POST",
    body: { login },
  });
  out.say(`Heartbeat sent (${login} → ${name}).`);
}

export async function runTeamDiscover(out: Output, opts: { timeoutMs?: number } = {}): Promise<void> {
  out.detail("Listening for TeamSync servers on the local network…");
  const found = await discoverServers(Math.min(opts.timeoutMs ?? 2500, 10_000));
  if (found.length === 0) {
    out.warn("No servers found. Check that `teamsync serve` is running; broadcasts may be blocked on some networks/WSL.");
    out.detail("Fallback: use the explicit address — --server http://<host-ip>:4700");
    return;
  }
  for (const beacon of found) {
    out.say(`  ${beacon.name}  →  http://${beacon.address}:${beacon.port}  (${beacon.teams} team(s))`);
  }
  out.detail("Use one with: teamsync team list --server http://<address>");
}
