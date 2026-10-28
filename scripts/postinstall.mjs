#!/usr/bin/env node
// npm postinstall hook — first-run setup. NEVER fails the install: any error
// degrades to printed guidance. Set TEAMSYNC_NO_SETUP=1 to opt out entirely.
try {
  const mod = await import(new URL("../dist/setup/postinstall.js", import.meta.url).href);
  await mod.runPostinstall();
} catch (err) {
  console.log(`teamsync: first-run setup skipped (${err && err.message ? err.message : err})`);
  console.log("  Install gh from https://cli.github.com/ then run: teamsync login");
}
process.exit(0);
