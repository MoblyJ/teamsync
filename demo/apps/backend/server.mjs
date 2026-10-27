// apps/backend/ — demo API server. Composes the services layer, exposes the
// shared contract over HTTP. Zero dependencies (node:http).
import { createServer } from "node:http";
import { fetchRepoTasks } from "../../services/integrations/github-events.mjs";
import { isValidTask, apiOk, apiError, cliVersion } from "../../packages/contracts/contracts.mjs";

/** @type {Array<import('../../packages/contracts/contracts.mjs').Task>} */
const tasks = [];

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(200, apiOk({ status: "up", cliVersion: cliVersion() }));
    }

    if (req.method === "GET" && url.pathname === "/api/tasks") {
      const fromServices = fetchRepoTasks(); // services layer
      return send(200, apiOk([...fromServices.data, ...tasks])); // contract envelope
    }

    if (req.method === "POST" && url.pathname === "/api/tasks") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(400, apiError("invalid JSON"));
        }
        // Contract enforcement at the boundary: reject mismatched payloads.
        if (!isValidTask(parsed)) return send(422, apiError("payload violates the Task contract"));
        tasks.push(parsed);
        return send(201, apiOk(parsed));
      });
      return;
    }

    return send(404, apiError(`no route: ${req.method} ${url.pathname}`));
  });
}

// Direct execution: `node demo/apps/backend/server.mjs [port]`
if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  const port = Number(process.argv[2] ?? 8787);
  createApp().listen(port, () => {
    console.log(`demo backend listening on http://localhost:${port}`);
  });
}
