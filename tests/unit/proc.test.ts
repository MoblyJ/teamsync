// Unit tests — subprocess execution: argument arrays, no shell interpolation,
// spaces in paths, timeouts, stdin. Cross-platform by using process.execPath.
import { describe, expect, it } from "vitest";
import path from "node:path";
import { run, needsShell, quoteForShell, executableName } from "../../src/core/proc.js";

const NODE = process.execPath;

describe("run()", () => {
  it("passes argument arrays verbatim — no shell splitting", async () => {
    const res = await run(NODE, ["-e", `console.log(process.argv.slice(1).join("|"))`, "a b", 'c"d', "e'f"]);
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe("a b|c\"d|e'f");
  });

  it("handles paths containing spaces", async () => {
    const res = await run(NODE, ["-e", "console.log('ok space-test')"]);
    expect(res.stdout).toContain("ok space-test");
    // And a cwd with spaces:
    const res2 = await run(NODE, ["-e", "console.log(process.cwd().length > 0 ? 'cwd-ok' : 'cwd-bad')"], {
      cwd: path.join(process.cwd(), "tests", "unit"),
    });
    expect(res2.stdout).toContain("cwd-ok");
  });

  it("feeds stdin", async () => {
    const res = await run(NODE, ["-e", "let d=''; process.stdin.on('data',(c)=>d+=c); process.stdin.on('end',()=>console.log('got:'+d.trim()))"], {
      input: "hello-stdin",
    });
    expect(res.stdout).toContain("got:hello-stdin");
  });

  it("times out runaway processes", async () => {
    await expect(
      run(NODE, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 300 }),
    ).rejects.toThrow(/timed out/);
  }, 5_000);

  it("reports nonzero exits without throwing", async () => {
    const res = await run(NODE, ["-e", "process.exit(3)"]);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
  });

  it("throws a clear error for missing executables", async () => {
    await expect(run("definitely-not-a-real-binary-xyz", ["--version"])).rejects.toThrow();
  });
});

describe("platform helpers", () => {
  it("executableName adds .exe only on win32", () => {
    expect(executableName("gh", "linux")).toBe("gh");
    expect(executableName("gh", "darwin")).toBe("gh");
    expect(executableName("gh", "win32")).toBe("gh.exe");
  });

  it("needsShell is true only for Windows batch shims", () => {
    expect(needsShell("gh.cmd", "win32")).toBe(true);
    expect(needsShell("C:\\tools\\gh.bat", "win32")).toBe(true);
    expect(needsShell("gh.exe", "win32")).toBe(false);
    expect(needsShell("gh", "linux")).toBe(false);
    expect(needsShell("gh.cmd", "linux")).toBe(false); // on linux it's just a filename
  });

  it("quoteForShell survives quotes and spaces", () => {
    expect(quoteForShell(["a b", 'c"d', "plain"])).toBe('"a b" "c""d" plain');
  });
});
