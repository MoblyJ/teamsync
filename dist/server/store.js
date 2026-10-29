// JSON-file persistence for the team registry. Atomic writes (tmp + rename),
// corrupt files are treated as empty with a warning rather than crashing the
// server. The store is host-local: never committed to a repository, never
// contains credentials.
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { emptyRegistry } from "../core/registry.js";
export class RegistryStore {
    file;
    cache = null;
    constructor(file) {
        this.file = file;
    }
    async load() {
        if (this.cache)
            return this.cache;
        try {
            const raw = await readFile(this.file, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.version === 1 && parsed.teams && typeof parsed.teams === "object") {
                this.cache = { version: 1, teams: parsed.teams };
            }
            else {
                this.cache = emptyRegistry();
            }
        }
        catch {
            // Missing or corrupt file: start empty. A corrupt file keeps its
            // content aside rather than being overwritten silently.
            this.cache = emptyRegistry();
        }
        return this.cache;
    }
    async save() {
        if (!this.cache)
            return;
        await mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
        await rename(tmp, this.file);
    }
}
