// Unit tests — tunnel URL parsing and cloudflared path resolution (pure).
import { describe, expect, it } from "vitest";
import { parseTunnelUrl, cloudflaredCandidates, resolveCloudflaredPath } from "../../src/commands/serve.js";

describe("parseTunnelUrl", () => {
  it("extracts the trycloudflare URL from real cloudflared log lines", () => {
    const log = [
      "2026-10-28T13:54:39Z INF +--------------------------------------------------------------------------------------------+",
      "2026-10-28T13:54:39Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "2026-10-28T13:54:39Z INF |  https://breach-sea-ram-legislation.trycloudflare.com                                       |",
      "2026-10-28T13:54:39Z INF +--------------------------------------------------------------------------------------------+",
    ].join("\n");
    expect(parseTunnelUrl(log)).toBe("https://breach-sea-ram-legislation.trycloudflare.com");
  });

  it("returns null when no URL has appeared yet (still connecting)", () => {
    expect(parseTunnelUrl("INF Starting tunnel… INF Registered tunnel connection")).toBeNull();
    expect(parseTunnelUrl("")).toBeNull();
  });

  it("does not match unrelated hostnames", () => {
    expect(parseTunnelUrl("see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps")).toBeNull();
  });
});

describe("resolveCloudflaredPath / candidates", () => {
  it("TEAMSYNC_CLOUDFLARED wins without probing the filesystem", async () => {
    process.env.TEAMSYNC_CLOUDFLARED = "/custom/cf";
    try {
      expect(await resolveCloudflaredPath(async () => false)).toBe("/custom/cf");
    } finally {
      delete process.env.TEAMSYNC_CLOUDFLARED;
    }
  });

  it("first existing candidate path wins", async () => {
    const candidates = cloudflaredCandidates("linux", "/home/x");
    expect(candidates[0]).toBe("/home/x/.local/bin/cloudflared");
    const picked = await resolveCloudflaredPath(async (p) => p === candidates[1]);
    expect(picked).toBe(candidates[1]);
  });

  it("falls back to the bare PATH name when nothing exists", async () => {
    expect(await resolveCloudflaredPath(async () => false)).toBe("cloudflared");
  });

  it("windows candidates include LOCALAPPDATA", () => {
    const list = cloudflaredCandidates("win32", "C:\\Users\\x");
    expect(list[0]).toMatch(/cloudflared\.exe$/);
    expect(list.some((c) => c.endsWith(".exe"))).toBe(true);
  });
});
