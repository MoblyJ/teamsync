// Unit tests — the MCP server's protocol handling (no subprocess needed).
import { describe, expect, it } from "vitest";
import { handleMessage, listTools } from "../../src/mcp/server.js";

const rpc = (method: string, params?: Record<string, unknown>, id: number | string = 1) =>
  handleMessage({ jsonrpc: "2.0", id, method, params });

describe("MCP protocol", () => {
  it("initialize returns protocol version + tools capability", async () => {
    const res = (await rpc("initialize")) as { result: Record<string, unknown> };
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect((res.result.serverInfo as { name: string }).name).toBe("teamsync");
  });

  it("notifications produce no response (stdin stays quiet)", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });

  it("ping answers {}", async () => {
    const res = (await rpc("ping")) as { result: unknown };
    expect(res.result).toEqual({});
  });

  it("tools/list exposes the full tool surface", async () => {
    const res = (await rpc("tools/list")) as { result: { tools: Array<{ name: string }> } };
    const names = res.result.tools.map((t) => t.name);
    for (const expected of [
      "teamsync_doctor",
      "teamsync_start",
      "teamsync_stage",
      "teamsync_commit",
      "teamsync_push",
      "teamsync_submit",
      "teamsync_status",
      "teamsync_sync",
      "teamsync_team_list",
    ]) {
      expect(names).toContain(expected);
    }
    expect(listTools()).toHaveLength(names.length);
  });

  it("tools/call with an unknown tool is a JSON-RPC error", async () => {
    const res = (await rpc("tools/call", { name: "nope", arguments: {} })) as {
      error: { code: number; message: string };
    };
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/Unknown tool/);
  });

  it("tools/call surfaces TeamSync failures as isError with hints (non-enrolled cwd)", async () => {
    // The test cwd (this project) is a git repo WITHOUT .teamsync/config.json,
    // so a repo command must fail with actionable hints, not crash the server.
    const res = (await rpc("tools/call", { name: "teamsync_status", arguments: {} })) as {
      result: { content: Array<{ type: string; text: string }>; isError: boolean };
    };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.type).toBe("text");
    expect(res.result.content[0]!.text).toMatch(/teamsync|config/i);
  });

  it("unknown methods map to -32601", async () => {
    const res = (await rpc("resources/list")) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });
});
