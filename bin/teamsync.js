#!/usr/bin/env node
// Thin launcher: keeps the published package's bin entry stable while the
// implementation lives in dist/. No logic here on purpose.
import "../dist/cli.js";
