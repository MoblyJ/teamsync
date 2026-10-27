// Template access: setup files written into user repositories by
// `teamsync init`. Resolved relative to the installed package layout
// (dist/commands → package_root/templates), so it works from the repo, from
// a global install, and from an npx cache alike.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function templatesDir(): string {
  // dist/commands/template-files.js → ../../templates
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

export async function readTemplate(name: string): Promise<string> {
  return readFile(path.join(templatesDir(), name), "utf8");
}

export interface SetupFile {
  repoPath: string;
  templateName: string;
  description: string;
}

export const SETUP_FILES: readonly SetupFile[] = [
  {
    repoPath: ".github/PULL_REQUEST_TEMPLATE.md",
    templateName: "PULL_REQUEST_TEMPLATE.md",
    description: "PR template with role/scope checklist",
  },
  {
    repoPath: ".github/workflows/integration.yml",
    templateName: "integration.yml",
    description: "CI integration gate (pull_request only, least privilege, aggregate check)",
  },
  {
    repoPath: "packages/contracts/README.md",
    templateName: "contracts-readme.md",
    description: "Shared contracts directory guidance",
  },
  {
    repoPath: "packages/contracts/contracts.ts",
    templateName: "contracts.ts",
    description: "Starter shared contracts",
  },
  {
    repoPath: "docs/teamsync.md",
    templateName: "teamsync-doc.md",
    description: "Team collaboration guidance",
  },
];
