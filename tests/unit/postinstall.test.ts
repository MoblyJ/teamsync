// Unit tests — first-run setup decision logic (pure functions, no I/O).
import { describe, expect, it } from "vitest";
import { decideSetupAction, pickInstallCommand, type SetupFacts } from "../../src/setup/postinstall.js";

const facts = (over: Partial<SetupFacts>): SetupFacts => ({
  ghInstalled: true,
  ghAuthenticated: true,
  interactive: true,
  disabledByEnv: false,
  isDevRepoInstall: false,
  ...over,
});

describe("decideSetupAction", () => {
  it("everything ready → done (leave it be)", () => {
    expect(decideSetupAction(facts({}))).toBe("done");
  });

  it("gh missing, interactive → install-gh (sudo prompt path)", () => {
    expect(decideSetupAction(facts({ ghInstalled: false, ghAuthenticated: false }))).toBe("install-gh");
  });

  it("gh present but not logged in, interactive → login", () => {
    expect(decideSetupAction(facts({ ghAuthenticated: false }))).toBe("login");
  });

  it("non-interactive (npm install in CI) → skip with hint, never blocks", () => {
    expect(decideSetupAction(facts({ ghInstalled: false, interactive: false }))).toBe("skip-noninteractive");
    expect(decideSetupAction(facts({ ghAuthenticated: false, interactive: false }))).toBe("skip-noninteractive");
  });

  it("TEAMSYNC_NO_SETUP=1 or dev-repo install → silent skip", () => {
    expect(decideSetupAction(facts({ ghInstalled: false, disabledByEnv: true }))).toBe("skip");
    expect(decideSetupAction(facts({ ghInstalled: false, isDevRepoInstall: true }))).toBe("skip");
  });
});

describe("pickInstallCommand", () => {
  it("linux uses sudo + apt", () => {
    const cmd = pickInstallCommand("linux")!;
    expect(cmd.sudo).toBe(true);
    expect(cmd.file).toBe("apt-get");
    expect(cmd.args).toContain("gh");
  });
  it("macOS uses brew (no sudo)", () => {
    const cmd = pickInstallCommand("darwin")!;
    expect(cmd.sudo).toBe(false);
    expect(cmd.file).toBe("brew");
  });
  it("windows uses winget", () => {
    expect(pickInstallCommand("win32")!.file).toBe("winget");
  });
  it("unknown platforms → null (manual guidance instead of guessing)", () => {
    expect(pickInstallCommand("freebsd")).toBeNull();
  });
});
