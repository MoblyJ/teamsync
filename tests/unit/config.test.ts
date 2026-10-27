// Unit tests — config validation (MOCK data only; no network, no fs).
import { describe, expect, it } from "vitest";
import { TeamsyncError } from "../../src/core/errors.js";
import {
  parseConfig,
  classifyPath,
  globMatch,
  slugifyTaskName,
  isValidBranchName,
  isValidRoleName,
  parseRepositorySlug,
  validatePathPattern,
  serializeConfig,
  DEFAULT_ROLES,
  DEFAULT_SHARED_PATHS,
  type TeamsyncConfig,
} from "../../src/core/config.js";

const valid: TeamsyncConfig = {
  version: 1,
  repository: "example/demo",
  defaultBranch: "main",
  roles: {
    backend: { paths: ["apps/backend/**"] },
    frontend: { paths: ["apps/frontend/**", "packages/contracts/**"] },
  },
  sharedPaths: ["packages/contracts/**", "package-lock.json"],
  checks: { required: ["integration"] },
  mergePolicy: { method: "squash", autoMerge: true, deleteBranchOnMerge: true },
};

describe("parseConfig", () => {
  it("accepts a valid config (MOCK)", () => {
    const cfg = parseConfig(JSON.parse(JSON.stringify(valid)));
    expect(cfg.repository).toBe("example/demo");
    expect(cfg.checks.required).toEqual(["integration"]);
    expect(cfg.mergePolicy.method).toBe("squash");
  });

  it("fills defaults for roles, sharedPaths, and mergePolicy", () => {
    const cfg = parseConfig({ version: 1, repository: "a/b", defaultBranch: "main" });
    expect(Object.keys(cfg.roles).sort()).toEqual(["backend", "frontend", "qa", "services"]);
    expect(cfg.roles).toEqual(DEFAULT_ROLES);
    expect(cfg.sharedPaths).toEqual(DEFAULT_SHARED_PATHS);
    expect(cfg.mergePolicy).toEqual({ method: "squash", autoMerge: true, deleteBranchOnMerge: true });
  });

  it("rejects unsupported future config versions with an update hint", () => {
    expect(() => parseConfig({ version: 99, repository: "a/b", defaultBranch: "main" })).toThrow(/Update the CLI/);
    try {
      parseConfig({ version: 99, repository: "a/b", defaultBranch: "main" });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamsyncError);
      expect((e as { hints: string[] }).hints.join(" ")).toMatch(/npm install -g/);
    }
  });

  it("rejects older versions", () => {
    expect(() => parseConfig({ version: 0, repository: "a/b", defaultBranch: "main" })).toThrow(/no longer supported/);
  });

  it("rejects missing version", () => {
    expect(() => parseConfig({ repository: "a/b", defaultBranch: "main" })).toThrow(/missing "version"/);
  });

  it("rejects invalid repository slugs", () => {
    for (const bad of ["noddi", "a/b/c", "a/", "/b", "a/../b", "", "a b/c d"]) {
      expect(() => parseConfig({ version: 1, repository: bad, defaultBranch: "main" })).toThrow(/OWNER\/REPO|invalid/);
    }
  });

  it("rejects invalid default branch names", () => {
    expect(() => parseConfig({ version: 1, repository: "a/b", defaultBranch: "" })).toThrow();
    expect(() => parseConfig({ version: 1, repository: "a/b", defaultBranch: "bad..name" })).toThrow();
    expect(() => parseConfig({ version: 1, repository: "a/b", defaultBranch: "in space" })).toThrow();
  });

  it("rejects path patterns that escape the repository", () => {
    expect(() =>
      parseConfig({ version: 1, repository: "a/b", defaultBranch: "main", roles: { x: { paths: ["../escape"] } } }),
    ).toThrow(/escapes the repository/);
  });

  it("rejects absolute path patterns", () => {
    expect(() =>
      parseConfig({ version: 1, repository: "a/b", defaultBranch: "main", roles: { x: { paths: ["/etc/passwd"] } } }),
    ).toThrow(/absolute/);
    expect(() =>
      parseConfig({ version: 1, repository: "a/b", defaultBranch: "main", roles: { x: { paths: ["C:\\tmp"] } } }),
    ).toThrow(/absolute/);
  });

  it("rejects invalid role names", () => {
    expect(() =>
      parseConfig({ version: 1, repository: "a/b", defaultBranch: "main", roles: { "Bad Role": { paths: ["x/**"] } } }),
    ).toThrow(/invalid role name/);
  });

  it("rejects roles with empty paths", () => {
    expect(() =>
      parseConfig({ version: 1, repository: "a/b", defaultBranch: "main", roles: { x: { paths: [] } } }),
    ).toThrow(/empty "paths"/);
  });

  it("validates mergePolicy values", () => {
    expect(() =>
      parseConfig({ version: 1, repository: "a/b", defaultBranch: "main", mergePolicy: { method: "rebase-ff" } }),
    ).toThrow(/mergePolicy.method/);
    expect(() =>
      parseConfig({ version: 1, repository: "a/b", defaultBranch: "main", mergePolicy: { method: "merge", autoMerge: "yes" } }),
    ).toThrow(/boolean/);
  });

  it("round-trips through serializeConfig", () => {
    const cfg = parseConfig(JSON.parse(JSON.stringify(valid)));
    const again = parseConfig(JSON.parse(serializeConfig(cfg)));
    expect(again).toEqual(cfg);
  });
});

describe("globMatch / classifyPath", () => {
  const cfg: TeamsyncConfig = {
    ...valid,
    roles: {
      frontend: { paths: ["apps/frontend/**", "packages/contracts/**"] },
      backend: { paths: ["apps/backend/**"] },
    },
    sharedPaths: ["packages/contracts/**", "package.json"],
  };

  it("matches recursive globs", () => {
    expect(globMatch("apps/frontend/**", "apps/frontend/src/app.ts")).toBe(true);
    expect(globMatch("apps/frontend/**", "apps/frontend")).toBe(true);
    expect(globMatch("apps/frontend/**", "apps/backend/src/app.ts")).toBe(false);
  });

  it("classifies role paths (MOCK classification)", () => {
    expect(classifyPath(cfg, "frontend", "apps/frontend/src/app.ts")).toBe("role");
    expect(classifyPath(cfg, "frontend", "apps/backend/x.js")).toBe("outside-role");
    expect(classifyPath(cfg, "frontend", "packages/contracts/types.ts")).toBe("shared");
    expect(classifyPath(cfg, "frontend", "docs/random.md")).toBe("unowned");
    expect(classifyPath(cfg, "unknown-role", "apps/frontend/src/app.ts")).toBe("unowned");
  });

  it("windows separators classify the same", () => {
    expect(classifyPath(cfg, "frontend", "apps\\frontend\\src\\app.ts")).toBe("role");
  });
});

describe("identifiers", () => {
  it("slugifyTaskName keeps branch-safe slugs", () => {
    expect(slugifyTaskName("Add Homepage!!")).toBe("add-homepage");
    expect(slugifyTaskName("  fix: login bug  ")).toBe("fix-login-bug");
    expect(slugifyTaskName("héllo wörld")).toBe("hello-world");
    expect(slugifyTaskName("///")).toBe("task");
    expect(slugifyTaskName("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });

  it("validates branch names against git rules", () => {
    expect(isValidBranchName("teamsync/alice/frontend/homepage-a1b2c3")).toBe(true);
    expect(isValidBranchName("main")).toBe(true);
    expect(isValidBranchName("bad..name")).toBe(false);
    expect(isValidBranchName("leading/slash//double")).toBe(false);
    expect(isValidBranchName("ends-with-lock.lock")).toBe(false);
    expect(isValidBranchName("ends/with/slash/")).toBe(false);
    expect(isValidBranchName("")).toBe(false);
  });

  it("validates role names and repo slugs", () => {
    expect(isValidRoleName("frontend")).toBe(true);
    expect(isValidRoleName("qa-integration")).toBe(true);
    expect(isValidRoleName("Front End")).toBe(false);
    expect(parseRepositorySlug("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseRepositorySlug("owner/repo.git")).toEqual({ owner: "owner", repo: "repo.git" });
    expect(parseRepositorySlug("justone")).toBeNull();
    expect(parseRepositorySlug("a/../b")).toBeNull();
  });

  it("validatePathPattern rejects traversal and absolute paths", () => {
    expect(() => validatePathPattern("..", "test")).toThrow();
    expect(() => validatePathPattern("a/../../b", "test")).toThrow();
    expect(() => validatePathPattern("/abs", "test")).toThrow();
    expect(() => validatePathPattern("ok/path/**", "test")).not.toThrow();
  });
});
