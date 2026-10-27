// Fake `gh` executable for adapter tests. Mocks GitHub ONLY at the adapter
// boundary: a real subprocess named gh whose responses come from a scenario
// file, and whose argv is logged so tests can assert exact argument arrays.
// All results produced through this shim are labeled MOCK in test output.
import { mkdtemp, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_SOURCE = String.raw`#!/usr/bin/env node
// Fake gh — reads scenario JSON from an embedded path and logs argv as JSONL.
// Tests inject behavior at generation time; this file never touches network.
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";

const statePath = "__STATE_PATH__";
const logPath = "__LOG_PATH__";
const state = JSON.parse(readFileSync(statePath, "utf8"));
const argv = process.argv.slice(2);

appendFileSync(logPath, JSON.stringify({ argv }) + "\n");

function respond(status, body) {
  if (status >= 400) {
    const messages = {
      401: "gh: Bad credentials (HTTP 401)",
      403: "gh: Resource not accessible by integration (HTTP 403)",
      404: "gh: Not Found (HTTP 404)",
      422: "gh: JSON: " + JSON.stringify(body ?? { message: "unprocessable" }) + " (HTTP 422)",
      429: "gh: API rate limit exceeded (HTTP 429)",
      500: "gh: server error (HTTP 500)",
    };
    process.stderr.write(messages[status] ?? "gh: error (HTTP " + status + ")");
    process.exit(1);
  }
  process.stdout.write(typeof body === "string" ? body : JSON.stringify(body));
  process.exit(0);
}

function parseFlags(args) {
  const flags = { f: {}, F: {}, raw: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f") { const [k, ...v] = args[i + 1].split("="); flags.f[k] = v.join("="); i++; }
    else if (args[i] === "-F") { const [k, ...v] = args[i + 1].split("="); flags.F[k] = v.join("="); i++; }
    else flags.raw.push(args[i]);
  }
  return flags;
}

async function main() {
  const flags = parseFlags(argv);

  if (argv.includes("--version")) return respond(200, "gh version 2.0.0-fake\n");
  if (argv[0] === "auth" && argv[1] === "logout") return respond(200, "Logged out (MOCK)\n");
  if (argv[0] === "auth" && argv[1] === "status") return respond(200, "github.com\\n  ✓ Logged in (MOCK)\n");
  if (argv[0] !== "api") return respond(400, { message: "fake gh only supports api" });

  // Read stdin body for --input -
  let stdinBody = null;
  if (argv.includes("--input")) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    stdinBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  const rest = flags.raw.filter((a) => a !== "api" && a !== "--input" && a !== "-" && a !== "--paginate");
  const [resource] = rest;

  if (state.error) return respond(state.error.status, state.error.body);

  // GraphQL
  if (argv.includes("graphql")) {
    const query = flags.f.query ?? "";
    if (query.includes("enablePullRequestAutoMerge")) {
      state.autoMergeEnabled = state.autoMergeEnabled || [];
      state.autoMergeEnabled.push(flags.f.id);
      // Fidelity: real GitHub reflects auto_merge on the PR immediately.
      const target = (state.prs ?? []).find((p) => p.node_id === flags.f.id);
      if (target) target.auto_merge = { enabled_by: { login: state.user.login }, merge_method: (flags.f.m ?? "SQUASH").toLowerCase() };
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      return respond(200, { enablePullRequestAutoMerge: { pullRequest: { number: 1 } } });
    }
    if (query.includes("pullRequest(number:")) {
      const num = Number(flags.F.num);
      const pr = state.prs.find((p) => p.number === num);
      if (!pr) return respond(200, { repository: { pullRequest: null } });
      return respond(200, {
        repository: { pullRequest: { id: pr.node_id, reviewDecision: state.reviewDecision ?? null } },
      });
    }
    return respond(200, {});
  }

  // REST routing — bare endpoints first, then repos/{owner}/{repo}/...
  if (resource === "user") return respond(200, state.user);
  if (resource === "rate_limit") return respond(200, {});

  const m = resource?.match(/^repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return respond(404, {});
  const [, , , tail = ""] = m;

  if (tail === "" || tail === undefined) return respond(200, state.repo);
  if (tail === "/pulls") {
    const isCreate = argv.includes("--method") && argv[argv.indexOf("--method") + 1] === "POST";
    if (isCreate) {
      const dup = state.prs.find((p) => p.head.ref === stdinBody.head && p.state === "open");
      if (dup) {
        const msg = "Validation Failed: pull request already exists for " + stdinBody.head;
        return respond(422, { message: msg });
      }
      const pr = {
        node_id: "PR_" + (state.prs.length + 1),
        number: state.prs.length + 1,
        html_url: "https://github.com/example/demo/pull/" + (state.prs.length + 1),
        title: stdinBody.title,
        state: "open",
        draft: stdinBody.draft === true,
        user: { login: state.user.login },
        head: { ref: stdinBody.head, sha: state.headSha ?? "0000000000000000000000000000000000000000" },
        base: { ref: stdinBody.base, sha: "1111111111111111111111111111111111111111" },
        mergeable: null,
        mergeable_state: "unknown",
        auto_merge: null,
      };
      state.prs.push(pr);
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      return respond(200, pr);
    }
    if (state.prsFailOpen) return respond(200, []);
    return respond(200, state.prs.filter((p) => flags.f.state ? p.state === flags.f.state : true));
  }
  const pm = tail.match(/^\/pulls\/(\d+)$/);
  if (pm) {
    const pr = state.prs.find((p) => p.number === Number(pm[1]));
    if (!pr) return respond(404, {});
    const isPatch = argv.includes("--method") && argv[argv.indexOf("--method") + 1] === "PATCH";
    if (isPatch) Object.assign(pr, stdinBody);
    return respond(200, pr);
  }
  const cm = tail.match(/^\/commits\/([0-9a-f]+)\/check-runs$/);
  if (cm) return respond(200, state.checkRuns ?? { total_count: 0, check_runs: [] });
  const sm = tail.match(/^\/commits\/([0-9a-f]+)\/status$/);
  if (sm) return respond(200, { sha: sm[1], statuses: state.statuses ?? [] });
  const bm = tail.match(/^\/branches\/([^/]+)\/protection$/);
  if (bm) {
    if (state.protection === null) return respond(404, {});
    return respond(200, state.protection ?? {
      strict: true,
      required_status_checks: { contexts: [], checks: [{ context: "integration" }] },
      required_pull_request_reviews: { required_approving_review_count: 0 },
    });
  }
  return respond(404, {});
}

main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
`;

export interface FakeGh {
  binDir: string;
  ghPath: string;
  statePath: string;
  logPath: string;
  /** Read the current scenario state (PRs created, auto-merge enabled, ...). */
  readState(): Promise<Record<string, unknown>>;
  /** Read the argv log — one JSON object per invocation. */
  readLog(): Promise<Array<{ argv: string[] }>>;
  setState(state: Record<string, unknown>): Promise<void>;
  cleanup(): Promise<void>;
}

export function defaultState(): Record<string, unknown> {
  return {
    user: { login: "alice", name: "Alice" },
    repo: {
      full_name: "example/demo",
      default_branch: "main",
      private: false,
      has_issues: true,
      allow_auto_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      allow_update_branch: true,
      delete_branch_on_merge: true,
      viewer_permission: "write",
    },
    prs: [],
    protection: {
      strict: true,
      required_status_checks: { contexts: [], checks: [{ context: "integration" }] },
      required_pull_request_reviews: { required_approving_review_count: 0 },
    },
    checkRuns: { total_count: 0, check_runs: [] },
    statuses: [],
  };
}

export async function makeFakeGh(initialState?: Record<string, unknown>): Promise<FakeGh> {
  const binDir = await mkdtemp(path.join(tmpdir(), "teamsync-fakegh-"));
  const scriptPath = path.join(binDir, "fake-gh.mjs");
  const statePath = path.join(binDir, "state.json");
  const logPath = path.join(binDir, "log.jsonl");
  // Embed absolute paths (JSON-escaped string literals, quotes included in
  // the placeholder) — no env coupling.
  const script = SHIM_SOURCE.replaceAll('"__STATE_PATH__"', JSON.stringify(statePath)).replaceAll(
    '"__LOG_PATH__"',
    JSON.stringify(logPath),
  );
  await writeFile(scriptPath, script, "utf8");

  await writeFile(statePath, JSON.stringify(initialState ?? defaultState(), null, 2), "utf8");
  await writeFile(logPath, "", "utf8");

  let ghPath: string;
  if (process.platform === "win32") {
    // cmd shim — proc.run routes .cmd through cmd.exe with explicit quoting.
    ghPath = path.join(binDir, "gh.cmd");
    await writeFile(ghPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");
  } else {
    ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env bash\nexec node "${scriptPath}" "$@"\n`, "utf8");
    await chmod(ghPath, 0o755);
  }

  return {
    binDir,
    ghPath,
    statePath,
    logPath,
    readState: async () => JSON.parse(await import("node:fs/promises").then((m) => m.readFile(statePath, "utf8"))),
    readLog: async () =>
      (await import("node:fs/promises").then((m) => m.readFile(logPath, "utf8")))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    setState: async (s) => {
      await writeFile(statePath, JSON.stringify(s, null, 2), "utf8");
    },
    cleanup: async () => {
      await import("node:fs/promises").then((m) => m.rm(binDir, { recursive: true, force: true }));
    },
  };
}

export { mkdir };
