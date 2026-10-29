// `teamsync serve` HTTP app: team registry REST API + live event stream (SSE)
// + a GitHub PR-status endpoint that REUSES the same core modules the CLI
// uses (buildTeamStatus/GhCliAdapter), so any external client gets exactly
// what `teamsync status` reports.
//
// Trust model: LAN-trust coordination. Identity = claimed GitHub login;
// membership is gated by per-team join codes; admin operations by the admin
// token shown once at creation. No GitHub credentials ever pass through here.
import http from "node:http";
import { URL } from "node:url";
import { isTeamsyncError, TeamsyncError, ExitCode } from "../core/errors.js";
import {
  createTeam,
  deleteTeam,
  heartbeat,
  joinTeam,
  leaveTeam,
  publicTeam,
  regenerateJoinCode,
  removeMember,
  setTeamRepository,
  showJoinCode,
} from "../core/registry.js";
import type { Registry } from "../core/registry.js";
import { buildTeamStatus } from "../core/status.js";
import { GhCliAdapter } from "../core/github.js";
import { parseConfig } from "../core/config.js";
import type { RegistryStore } from "./store.js";

export interface ServerOptions {
  port: number;
  host: string; // bind address
  ghPath?: string;
}

interface SseClient {
  res: http.ServerResponse;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function errBody(err: unknown): { error: { code: string; message: string; hints: string[] } } {
  if (isTeamsyncError(err)) {
    return { error: { code: err.code, message: err.message, hints: err.hints } };
  }
  return { error: { code: "internal", message: String(err), hints: [] } };
}

function errStatus(err: unknown): number {
  if (!isTeamsyncError(err)) return 500;
  switch (err.exitCode) {
    case ExitCode.USAGE:
      return 400;
    case ExitCode.NOT_FOUND:
      return 404;
    case ExitCode.BLOCKED:
    case ExitCode.AUTH:
      return 403;
    default:
      return 500;
  }
}

async function readJsonBody(req: http.IncomingMessage, limitBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new TeamsyncError({ message: "Request body too large.", code: "too-large", exitCode: ExitCode.USAGE });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new TeamsyncError({ message: "Request body is not valid JSON.", code: "bad-json", exitCode: ExitCode.USAGE });
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function createApp(store: RegistryStore, opts: ServerOptions): http.Server {
  const sseClients = new Set<SseClient>();

  const broadcast = (event: string, data: unknown): void => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.res.write(line);
  };

  const mutate = async (fn: (registry: Registry) => unknown, eventName?: string, eventData?: unknown): Promise<void> => {
    const registry = await store.load();
    await fn(registry); // throws TeamsyncError on rule violations
    await store.save();
    if (eventName) broadcast(eventName, eventData ?? {});
  };

  const adapter = new GhCliAdapter({ ghPath: opts.ghPath });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    // Registry is local, but permissive CORS keeps external clients simple.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ---- health --------------------------------------------------------
      if (method === "GET" && path === "/api/health") {
        sendJson(res, 200, { ok: true, server: "teamsync", version: 1 });
        return;
      }

      // ---- SSE event stream ----------------------------------------------
      if (method === "GET" && path === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write("retry: 3000\n\n");
        const client: SseClient = { res };
        sseClients.add(client);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ping);
          sseClients.delete(client);
        });
        return;
      }

      // ---- teams collection -----------------------------------------------
      if (path === "/api/teams") {
        if (method === "GET") {
          const registry = await store.load();
          sendJson(res, 200, {
            teams: Object.values(registry.teams)
              .map(publicTeam)
              .sort((a, b) => (a.name < b.name ? -1 : 1)),
          });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(req);
          let created!: Awaited<ReturnType<typeof createTeam>>;
          await mutate((registry) => {
            created = createTeam(registry, {
              name: str(body.name),
              adminLogin: str(body.adminLogin),
            });
          }, "team.created", { name: str(body.name) });
          broadcast("teams.changed", {});
          // joinCode/adminToken leave the server exactly once, here.
          sendJson(res, 201, {
            team: publicTeam(created.team),
            joinCode: created.joinCode,
            adminToken: created.adminToken,
          });
          return;
        }
      }

      // ---- one team ---------------------------------------------------------
      const teamMatch = /^\/api\/teams\/([^/]+)$/.exec(path);
      if (teamMatch) {
        const name = decodeURIComponent(teamMatch[1]!);
        const registry = await store.load();
        const team = registry.teams[name] ?? registry.teams[name.toLowerCase()];
        if (method === "GET") {
          if (!team) throw new TeamsyncError({ message: `Team "${name}" not found.`, code: "not-found", exitCode: ExitCode.NOT_FOUND });
          sendJson(res, 200, { team: publicTeam(team) });
          return;
        }
        if (method === "DELETE") {
          const body = await readJsonBody(req);
          await mutate((reg) => deleteTeam(reg, { name, adminToken: str(body.adminToken) }), "team.deleted", { name });
          sendJson(res, 200, { ok: true, deleted: name });
          return;
        }
      }

      // ---- team sub-actions ---------------------------------------------------
      const actionMatch = /^\/api\/teams\/([^/]+)\/(join|leave|heartbeat|repository|code|show-code|remove-member)$/.exec(path);
      if (actionMatch && method === "POST") {
        const name = decodeURIComponent(actionMatch[1]!);
        const action = actionMatch[2]!;
        const body = await readJsonBody(req);
        let response: unknown;

        switch (action) {
          case "join": {
            let team!: ReturnType<typeof joinTeam>;
            await mutate(
              (reg) => {
                team = joinTeam(reg, {
                  name,
                  login: str(body.login),
                  role: str(body.role),
                  joinCode: str(body.joinCode),
                  ...(str(body.clonePath) !== "" ? { clonePath: str(body.clonePath) } : {}),
                });
              },
              "team.member.joined",
              { name, login: str(body.login) },
            );
            response = { team: publicTeam(team) };
            break;
          }
          case "leave": {
            let team!: ReturnType<typeof leaveTeam>;
            await mutate((reg) => {
              team = leaveTeam(reg, { name, login: str(body.login) });
            }, "team.member.left", { name, login: str(body.login) });
            response = { team: publicTeam(team) };
            break;
          }
          case "heartbeat": {
            let team!: ReturnType<typeof heartbeat>;
            await mutate((reg) => {
              team = heartbeat(reg, {
                name,
                login: str(body.login),
                ...(str(body.branch) !== "" ? { branch: str(body.branch) } : {}),
              });
            });
            // Heartbeats don't rebroadcast to avoid chatty streams; lastSeen
            // is picked up by the dashboard's periodic refresh.
            response = { team: publicTeam(team) };
            break;
          }
          case "repository": {
            let team!: ReturnType<typeof setTeamRepository>;
            await mutate((reg) => {
              team = setTeamRepository(reg, {
                name,
                repository: str(body.repository),
                adminToken: str(body.adminToken),
              });
            }, "team.repository.set", { name, repository: str(body.repository) });
            response = { team: publicTeam(team) };
            break;
          }
          case "code": {
            let code = "";
            await mutate((reg) => {
              code = regenerateJoinCode(reg, { name, adminToken: str(body.adminToken) });
            }, "team.code.rotated", { name });
            response = { joinCode: code };
            break;
          }
          case "show-code": {
            const reg = await store.load();
            const code = showJoinCode(reg, { name, adminToken: str(body.adminToken) });
            response = { joinCode: code };
            break;
          }
          case "remove-member": {
            let team!: ReturnType<typeof removeMember>;
            await mutate((reg) => {
              team = removeMember(reg, { name, login: str(body.login), adminToken: str(body.adminToken) });
            }, "team.member.removed", { name, login: str(body.login) });
            response = { team: publicTeam(team) };
            break;
          }
        }
        broadcast("teams.changed", {});
        sendJson(res, 200, response);
        return;
      }

      // ---- GitHub PR status (reuses the CLI's core, host's gh auth) ----------
      const statusMatch = /^\/api\/repos\/([^/]+)\/([^/]+)\/status$/.exec(path);
      if (statusMatch && method === "GET") {
        const owner = decodeURIComponent(statusMatch[1]!);
        const repo = decodeURIComponent(statusMatch[2]!);
        const repoInfo = await adapter.getRepo(owner, repo);
        const config = parseConfig({
          version: 1,
          repository: `${owner}/${repo}`,
          defaultBranch: repoInfo.defaultBranch,
        });
        const me = await adapter.whoAmI();
        const status = await buildTeamStatus(adapter, config, me.login, {});
        sendJson(res, 200, status);
        return;
      }

      sendJson(res, 404, { error: { code: "not-found", message: `no route: ${method} ${path}`, hints: [] } });
    } catch (err) {
      sendJson(res, errStatus(err), errBody(err));
    }
  });
}
