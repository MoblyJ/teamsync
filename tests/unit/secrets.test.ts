// Unit tests — secret-file exclusion and output redaction.
import { describe, expect, it } from "vitest";
import { findLikelySecretFiles, splitExcluded } from "../../src/core/secrets.js";
import { redact } from "../../src/core/redact.js";

describe("findLikelySecretFiles", () => {
  it("flags common credential filenames", () => {
    const matches = findLikelySecretFiles([
      ".env",
      ".env.local",
      "server.pem",
      "private.key",
      "id_rsa",
      "deploy/id_ed25519",
      ".npmrc",
      ".git-credentials",
      "service-account-prod.json",
      "keystore.jks",
      "secrets.yaml",
      "credentials.json",
    ]);
    const flagged = new Set(matches.map((m) => m.path));
    expect(flagged.has(".env")).toBe(true);
    expect(flagged.has(".env.local")).toBe(true);
    expect(flagged.has("server.pem")).toBe(true);
    expect(flagged.has("private.key")).toBe(true);
    expect(flagged.has("id_rsa")).toBe(true);
    expect(flagged.has("deploy/id_ed25519")).toBe(true);
    expect(flagged.has(".npmrc")).toBe(true);
    expect(flagged.has(".git-credentials")).toBe(true);
    expect(flagged.has("service-account-prod.json")).toBe(true);
    expect(flagged.has("keystore.jks")).toBe(true);
    expect(flagged.has("secrets.yaml")).toBe(true);
    expect(flagged.has("credentials.json")).toBe(true);
  });

  it("does not flag ordinary source files", () => {
    const matches = findLikelySecretFiles([
      "src/index.ts",
      "apps/backend/server.js",
      "README.md",
      "public-key.pub", // public keys are fine to commit
      "keyshield.ts", // name merely contains 'key' as substring of a word
    ]);
    expect(matches).toHaveLength(0);
  });

  it("flags nested dotenv and token-ish paths", () => {
    const matches = findLikelySecretFiles(["config/.env.production", "auth/token-helper.js"]);
    expect(matches.map((m) => m.path)).toContain("config/.env.production");
  });
});

describe("splitExcluded", () => {
  it("partitions kept vs excluded with reasons", () => {
    const files = [{ path: ".env" }, { path: "src/a.ts" }, { path: "id_rsa" }];
    const excluded = findLikelySecretFiles(files.map((f) => f.path));
    const { kept, excludedFiles } = splitExcluded(files, excluded);
    expect(kept.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(excludedFiles.map((f) => f.path).sort()).toEqual([".env", "id_rsa"]);
  });
});

describe("redact", () => {
  it("scrubs github token shapes", () => {
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz012345 end")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(redact("ghs_0123456789abcdefghijklmnopqrstuvwxyz")).toContain("REDACTED");
    expect(redact("gho_0123456789abcdefghijklmnopqrstuvwxyz")).toContain("REDACTED");
  });

  it("scrubs labeled secrets in error text", () => {
    expect(redact("error: token=supersecret123 failed")).toContain("****REDACTED");
    expect(redact("password: hunter2")).not.toContain("hunter2");
  });

  it("scrubs 40-hex legacy tokens", () => {
    const hex = "a".repeat(40);
    expect(redact(`sha ${hex} end`)).not.toContain(hex);
  });

  it("leaves ordinary text alone", () => {
    expect(redact("pushed branch teamsync/alice/frontend/task-a1b2c3")).toBe(
      "pushed branch teamsync/alice/frontend/task-a1b2c3",
    );
  });
});
