// Unit tests — the pure team-registry state machine (admin rights, join
// codes, idempotent joins, member lifecycle). No I/O.
import { describe, expect, it } from "vitest";
import {
  createTeam,
  deleteTeam,
  emptyRegistry,
  heartbeat,
  isValidRole,
  isValidTeamName,
  joinTeam,
  leaveTeam,
  publicTeam,
  regenerateJoinCode,
  removeMember,
  setTeamRepository,
  showJoinCode,
} from "../../src/core/registry.js";

function newTeam(registry = emptyRegistry()) {
  const created = createTeam(registry, { name: "Hackers", adminLogin: "leo" });
  return { registry, created };
}

describe("team creation", () => {
  it("creator becomes the admin and sole member", () => {
    const { created } = newTeam();
    expect(created.team.admin).toBe("leo");
    expect(created.team.members.leo?.role).toBe("admin");
    expect(created.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(created.adminToken).toMatch(/^[0-9a-f]{48}$/);
  });

  it("rejects duplicate names (case-insensitive)", () => {
    const registry = emptyRegistry();
    createTeam(registry, { name: "Hackers", adminLogin: "leo" });
    expect(() => createTeam(registry, { name: "hackers", adminLogin: "mia" })).toThrow(/already exists/);
  });

  it("validates names and logins", () => {
    for (const bad of ["ab", "x".repeat(41), "has space", "", "-leading"]) {
      expect(isValidTeamName(bad)).toBe(false);
    }
    expect(isValidTeamName("hack-night-2026")).toBe(true);
    expect(() => createTeam(emptyRegistry(), { name: "okname", adminLogin: "" })).toThrow();
  });
});

describe("joining", () => {
  it("joins with the right code and role", () => {
    const { registry, created } = newTeam();
    const team = joinTeam(registry, { name: "hackers", login: "mia", role: "frontend", joinCode: created.joinCode });
    expect(team.members.mia?.role).toBe("frontend");
    expect(publicTeam(team).memberCount).toBe(2);
  });

  it("rejects a wrong join code", () => {
    const { registry } = newTeam();
    expect(() =>
      joinTeam(registry, { name: "hackers", login: "mia", role: "qa", joinCode: "WRONG!" }),
    ).toThrow(/wrong join code/i);
  });

  it("re-joining updates the role without duplicating the member", () => {
    const { registry, created } = newTeam();
    joinTeam(registry, { name: "hackers", login: "mia", role: "frontend", joinCode: created.joinCode });
    joinTeam(registry, { name: "hackers", login: "mia", role: "backend", joinCode: created.joinCode });
    const team = registry.teams.hackers!;
    expect(Object.keys(team.members)).toHaveLength(2);
    expect(team.members.mia?.role).toBe("backend");
  });

  it("validates roles and unknown teams", () => {
    const { registry, created } = newTeam();
    expect(isValidRole("Front End")).toBe(false);
    expect(() =>
      joinTeam(registry, { name: "hackers", login: "x", role: "Bad Role", joinCode: created.joinCode }),
    ).toThrow();
    expect(() =>
      joinTeam(registry, { name: "ghosts", login: "x", role: "qa", joinCode: "ABC234" }),
    ).toThrow(/does not exist/);
  });
});

describe("membership lifecycle", () => {
  it("admin cannot leave; members can", () => {
    const { registry, created } = newTeam();
    joinTeam(registry, { name: "hackers", login: "mia", role: "qa", joinCode: created.joinCode });
    expect(() => leaveTeam(registry, { name: "hackers", login: "leo" })).toThrow(/admin cannot leave/i);
    leaveTeam(registry, { name: "hackers", login: "mia" });
    expect(registry.teams.hackers!.members.mia).toBeUndefined();
  });

  it("remove-member requires the admin token", () => {
    const { registry, created } = newTeam();
    joinTeam(registry, { name: "hackers", login: "mia", role: "qa", joinCode: created.joinCode });
    expect(() => removeMember(registry, { name: "hackers", login: "mia", adminToken: "bogus" })).toThrow(/not the admin/i);
    removeMember(registry, { name: "hackers", login: "mia", adminToken: created.adminToken });
    expect(registry.teams.hackers!.members.mia).toBeUndefined();
  });

  it("heartbeat updates lastSeen for members only", () => {
    const { registry, created } = newTeam();
    joinTeam(registry, { name: "hackers", login: "mia", role: "qa", joinCode: created.joinCode });
    const team = heartbeat(registry, { name: "hackers", login: "mia", now: "2026-10-28T00:00:00Z" });
    expect(team.members.mia?.lastSeen).toBe("2026-10-28T00:00:00Z");
    expect(() => heartbeat(registry, { name: "hackers", login: "stranger" })).toThrow(/not a member/i);
  });
});

describe("admin operations", () => {
  it("rotate + show join code, gated by token", () => {
    const { registry, created } = newTeam();
    expect(() => showJoinCode(registry, { name: "hackers", adminToken: "nope" })).toThrow(/not the admin/i);
    expect(showJoinCode(registry, { name: "hackers", adminToken: created.adminToken })).toBe(created.joinCode);
    const next = regenerateJoinCode(registry, { name: "hackers", adminToken: created.adminToken });
    expect(next).not.toBe(created.joinCode);
    expect(() =>
      joinTeam(registry, { name: "hackers", login: "x", role: "qa", joinCode: created.joinCode }),
    ).toThrow(/wrong join code/i);
  });

  it("set repository validates the slug and needs the token", () => {
    const { registry, created } = newTeam();
    expect(() =>
      setTeamRepository(registry, { name: "hackers", repository: "nope", adminToken: created.adminToken }),
    ).toThrow(/OWNER\/REPO/);
    const team = setTeamRepository(registry, {
      name: "hackers",
      repository: "team/tictactoe",
      adminToken: created.adminToken,
    });
    expect(team.repository).toBe("team/tictactoe");
  });

  it("delete requires the token and removes the team", () => {
    const { registry, created } = newTeam();
    expect(() => deleteTeam(registry, { name: "hackers", adminToken: "bad" })).toThrow();
    deleteTeam(registry, { name: "hackers", adminToken: created.adminToken });
    expect(registry.teams.hackers).toBeUndefined();
  });

  it("publicTeam never leaks the join code or admin token", () => {
    const { created } = newTeam();
    const pub = JSON.stringify(publicTeam(created.team));
    expect(pub).not.toContain(created.joinCode);
    expect(pub).not.toContain(created.adminToken);
  });
});
