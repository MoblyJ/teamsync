# TeamSync

An npm-installable CLI that helps a small team (e.g. a four-person hackathon
team) collaborate on one GitHub repository through **role-aware task branches,
PRs, and GitHub-native auto-merge** — without a hosted backend.

- **Independent changes merge automatically** after required checks pass,
  using GitHub's own auto-merge (server-side; no watcher process needed).
- **Genuine conflicts stay blocked** for a human to resolve — TeamSync never
  silently resolves, never force-pushes, never deletes your work.
- **This is Git-based collaboration**, not live collaborative editing.
- Two ways to drive it: **manual commands** (below) or **AI tools via MCP**
  (`teamsync mcp`, 9 tools — see `docs/mcp-claude-code.md`).
- An optional **local team server** (`teamsync serve`) adds rosters, join
  codes, and heartbeats for everyone who installed the CLI.

Full command manual: **`docs/MANUAL.md`** · AI setup: `docs/mcp-claude-code.md`
· Live-merge verification: `docs/live-verification.md`

```
teamsync doctor    # verify prerequisites (explains; never auto-installs)
teamsync login     # GitHub login via gh (browser/device flow)
teamsync init      # owner: add shared config, PR template, CI gate
teamsync join      # teammates: clone + pick a role
teamsync start     # unique task branch per task
teamsync submit    # stage → commit → push → PR → auto-merge (one shot)
teamsync stage     #   …or step-by-step: stage
teamsync commit    #                     commit
teamsync push      #                     push
teamsync status    # PRs, checks, conflicts, blockers
teamsync watch     # poll until merged (read-only)
teamsync sync      # safely update from the default branch
teamsync serve     # optional: local team server (REST + SSE)
teamsync team …    #   create/join/list teams (admin + join codes)
teamsync logout    # remove the shared gh login (with confirmation)
```

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js ≥ 20 (LTS) | any current LTS release; tested on 20 and 22 |
| git ≥ 2.30 | https://git-scm.com/downloads |
| GitHub CLI (`gh`) | https://cli.github.com/ — TeamSync delegates ALL authentication to gh |
| A GitHub account **with push access** to the repository | `teamsync join` never grants access; an admin adds you on GitHub first |

Install gh per platform:

```sh
# macOS
brew install gh
# Windows (PowerShell)
winget install GitHub.cli
# Debian/Ubuntu (see docs for the apt repository setup)
sudo apt install gh
# WSL: install gh INSIDE the WSL distro (the Windows gh.exe is not on the
# Linux PATH by default; that is the correct setup for WSL).
```

Supported shells/platforms: Windows (PowerShell), macOS (zsh/bash), Linux, WSL.

## Installing guide

### Option A — install from npm (recommended)

```sh
npm install -g @devoko/teamsync
teamsync --version          # → 0.1.0
```

On npm ≤ 11, the first install automatically runs **first-run setup**:

- `gh` (GitHub CLI) not installed? It asks **y/N**, then installs it
  (sudo password may be requested; apt/brew/winget per platform).
- `gh` installed but not logged in? It offers **`gh auth login`** (browser or
  device code — your token stays inside gh).
- Everything ready? One line, and it leaves you alone.

Non-interactive shells (CI, scripts) are never prompted — they get printed
hints instead. Opt out entirely with `TEAMSYNC_NO_SETUP=1`.

> **npm ≥ 12 note:** npm now blocks lifecycle scripts (like our setup hook)
> unless the installer allows them. If setup didn't run, that's why — just
> run `teamsync doctor` once and follow its hints, or allow the script:
> `npm approve-scripts` in the global prefix. The CLI itself works fully
> without the hook; it only automates gh install/login.

### Option B — install straight from GitHub

```sh
npm install -g github:MoblyJ/teamsync
# npm ≥ 12 blocks git dependencies by default; add:
npm install -g github:MoblyJ/teamsync --allow-git
```

### Option C — hack on it locally, install your own build

```sh
git clone https://github.com/MoblyJ/teamsync.git
cd teamsync
npm install                 # runs build + tests prep
npm pack                    # → devoko-teamsync-0.1.0.tgz
npm install -g ./devoko-teamsync-0.1.0.tgz
```

After any option, check everything with `teamsync doctor`.

## One-time setup (repository owner)

```sh
teamsync doctor                          # all critical checks green first
teamsync login                           # delegates to `gh auth login`
git clone git@github.com:OWNER/REPO.git  # or https; git transport uses gh
cd REPO
teamsync init --repo OWNER/REPO
```

`init` creates a **setup branch and PR** containing (existing files are never
overwritten):

- `.teamsync/config.json` — validated, versioned shared config: repository
  identity, default branch, role→path mappings, required checks, merge policy
- `.github/workflows/integration.yml` — CI gate that runs on `pull_request`
  **only** (never `pull_request_target`), least-privilege, with an
  always-executing aggregate `integration` job
- `.github/PULL_REQUEST_TEMPLATE.md`, `docs/teamsync.md`
- `packages/contracts/` — the shared contract location for cross-role types

Then apply the **administrative settings** (TeamSync explains them; it never
changes repository settings or protections via the API):

1. Merge the setup PR.
2. **Settings → General → Pull Requests → ✅ Allow auto-merge.**
3. **Settings → Branches → protect the default branch**: require the
   **`integration`** check, and ✅ **Require branches to be up to date before
   merging**. Optionally require reviews — TeamSync respects whatever you
   configure.
4. **Settings → Actions → General**: default workflow permissions =
   **Read repository contents**.

### Plan limitations

- Auto-merge and merge queues are **free for public repositories**; private
  repositories need Team/Enterprise. If a setting is unavailable, TeamSync
  detects it and reports **manual merge mode** instead of pretending.
- Branch protection on private repos likewise requires a paid plan; without
  it, automatic merging is NOT safe and TeamSync says so.
- A **merge queue**, when configured, takes precedence over plain auto-merge;
  TeamSync detects what it can and reports the rest as unknown rather than
  guessing. Keep CI triggering on `merge_group` events (comment in the
  generated workflow shows where).

## Four-person onboarding

Each teammate (must already have GitHub access):

```sh
teamsync doctor
teamsync login
teamsync join OWNER/REPO --role services   # from ~/work or anywhere
cd REPO
# …the other three use --role backend, --role frontend, --role qa
```

`join` clones safely (refuses non-empty non-matching destinations, adopts an
existing matching clone), validates the shared config, and records your role
**locally** (in the platform user-config dir — never in the repo).

Role ownership is **advisory**: `submit` warns when you edit outside your
role's paths and highlights shared paths (contracts, lockfiles, workflows).
It is not access control — GitHub permissions decide.

## Command reference — two ways to work the same flow

**Manual mode** (step-by-step, plain-git style) and **vibe mode** (AI tools
via MCP) drive identical commands; pick per taste, mix freely.

| Step | Manual (one at a time) | Fast path | MCP tool |
| --- | --- | --- | --- |
| check setup | `teamsync doctor` | — | `teamsync_doctor` |
| start a task | `teamsync start homepage` | — | `teamsync_start` |
| stage | `teamsync stage --all` *(or paths)* | — | `teamsync_stage` |
| commit | `teamsync commit -m "Add homepage"` | — | `teamsync_commit` |
| push | `teamsync push` | — | `teamsync_push` |
| everything | — | `teamsync submit --all -m "…"` | `teamsync_submit` |
| team state | `teamsync status` | same | `teamsync_status` |
| catch up | `teamsync sync` | same | `teamsync_sync` |
| rosters | `teamsync team list` | same | `teamsync_team_list` |

Safety rails are identical in both modes: no implicit staging, secret-file
exclusion, no force-push, no rewrites, dirty-worktree refusals, one PR per
branch. AI failures return the same actionable hints the CLI prints, so the
assistant can self-correct.

### MCP connect clause

Claude Code / Claude Desktop / any stdio MCP client (`docs/mcp-claude-code.md`
has the full guide):

```json
{
  "mcpServers": {
    "teamsync": { "command": "teamsync", "args": ["mcp"] }
  }
}
```

This repo also ships a working `.mcp.json` (`node bin/teamsync.js mcp`) so
Claude Code gets the tools immediately in this project.

## Local team server (LAN mode)

TeamSync can run a **local coordination server** for everyone who installed
the CLI: the host runs `teamsync serve` in any folder (the folder's
name/project is irrelevant; their gh is already connected), and any number
of teams with any number of members can form on it. The person who creates a
team is its **admin**; everyone else joins as a normal user with the team's
one-time **join code**.

```
Host machine (any folder):
  teamsync serve                 # http://localhost:4700 (+ LAN address printed)

Admin (any installed user, identity = their gh login):
  teamsync team create hack-night        # → prints join code ONCE
  teamsync team repo hack-night OWNER/REPO   # team then tracks that repo's PRs

Teammates (same LAN or same machine):
  teamsync team join hack-night --role frontend --code <CODE> --server http://<host>:4700
  teamsync team heartbeat hack-night     # refresh "last seen"
```

Admin-only commands (token stored on the creator's machine): `team code`,
`team rotate-code`, `team remove-member`, `team repo`, `team delete`.
Everyone: `team list`, `team info`, `team leave`, `team discover`.
Registry state persists in `.teamsync-server.json` (gitignored) next to
wherever `serve` runs; restart-safe.

**Trust model:** identity is a claimed GitHub login verified by join-code
membership (admin token for admin ops). This is a LAN-trust coordination
server — it never sees or stores GitHub credentials. Anyone who can reach
the port can read team rosters; run it on a trusted network or bind
`--host 127.0.0.1` for single-machine use.

### Ways to talk to the server

1. **CLI** — every `team` subcommand (`--json` supported); server picked by
   `--server`, `TEAMSYNC_SERVER`, or the last used one.
2. **REST API** — `GET/POST /api/teams`, `GET/DELETE /api/teams/<name>`,
   `POST /api/teams/<name>/{join,leave,heartbeat,repository,code,show-code,remove-member}`,
   `GET /api/repos/<owner>/<repo>/status` (reuses the CLI's own status core
   with the host's gh auth). Same rules as the CLI; permissive CORS.
3. **Live event stream (SSE)** — `GET /api/events` pushes `teams.changed`
   etc. for any custom client.
4. **Different networks** — the code flow (`start/submit/status/sync`) talks
   to GitHub directly and works from any network. For the team server
   across networks, expose the port yourself (any tunnel/VPS you control)
   and pass its URL with `--server`. UDP `team discover` only works on a
   shared LAN.

## Daily workflow

```sh
teamsync start homepage
# creates teamsync/<login>/<role>/homepage-<suffix>, unique on the remote
# work in any editor…
teamsync submit --all -m "Add homepage"     # or name explicit paths
teamsync status                             # everyone's PRs and blockers
teamsync watch                              # poll until merged (Ctrl+C to stop)
teamsync sync                               # pull the updated base into your branch
```

`submit` never stages implicitly: pass `--all` or explicit paths. Likely
secret files (`.env`, keys, credentials stores, …) are **excluded by default**
and reported; explicitly naming one is a hard stop. Retries are idempotent:
the same PR is reused, never duplicated; pushes are checked against the
remote before retrying.

`sync` fast-forwards the default branch (strictly), and merges the updated
base into task branches (merge commit; history is never rewritten). On
conflict it aborts cleanly, lists the affected files, and prints recovery
steps — your files are byte-identical to before.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | general runtime error |
| 2 | usage error |
| 3 | blocked (dirty worktree, conflict, refused unsafe operation) |
| 4 | authentication expired/missing or insufficient permission |
| 5 | network failure or rate limit |
| 6 | not found (repo, config, branch) |
| 7 | invalid/unsupported `.teamsync/config.json` |
| 8 | capability unavailable (e.g. gh missing, feature not on plan) |

`status`, `doctor`, `submit`, `start`, `sync` support `--json` for
machine-readable output; `--events <file>` writes JSONL events (the seam a
future dashboard reads).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `gh is not installed` | install gh (above), then `teamsync doctor` |
| `401 Bad credentials` | `gh auth login` again — your gh login expired |
| `git could not authenticate` on push | run `gh auth setup-git` (login does this automatically) |
| `Allow auto-merge` missing | Settings → General → Pull Requests; needs admin, and a paid plan for private repos |
| PR stuck in `checks-blocked` | a required check never ran or was **skipped** — TeamSync refuses to call skipped checks success; use the aggregate `integration` gate from the template |
| PR `behind` | base moved: `teamsync sync`, then `teamsync submit` (fresh checks run against the new base) |
| Merge conflict | `teamsync sync` on your task branch; resolve, commit the merge, `teamsync submit` |
| `config version N not supported` | update the CLI: `npm install -g @devoko/teamsync@latest` |
| Rate limited in `watch` | it backs off automatically; increase `--interval` |
| WSL: pushes ask for username | install/run gh inside WSL, then `gh auth setup-git` there |

Credentials: TeamSync never sees, stores, or logs tokens. gh holds them;
output is scrubbed through a redactor as defense-in-depth; the published
package contains no credential material (CI verifies).

## What remains manual (honest limits)

- **Live auto-merge verification** requires a real GitHub repository with
  branch protection. Everything verifiable offline (branch uniqueness, PR
  reuse, conflict safety, check-state classification, adapter behavior) is
  covered by the test suite against real local git repos and a mock gh; the
  live GitHub behavior is covered by the checklist in `docs/live-verification.md`.
- TeamSync cannot read branch protection without admin rights — it says
  "unknown" instead of guessing.
- Merge-queue status is not readable without admin; enrollment attempts
  detect queue mode only by GitHub's response.

## Architecture notes (for a future dashboard)

```
src/
  core/        ← reusable, UI-free, fully injected
    config.ts      .teamsync/config.json schema + validation
    git.ts         GitClient (arg-array subprocesses, conflict-safe ops)
    github.ts      GitHubAdapter interface + gh CLI implementation
    policy.ts      integration state machine (stale checks, skipped≠success…)
    status.ts      team status model (dashboard-shaped)
    events.ts      structured JSONL events
    proc.ts        subprocess plumbing (no shell interpolation)
  commands/    ← thin handlers wiring core → CLI
  ui/          ← rendering only
templates/     ← files `init` writes into user repos
demo/          ← services / apps/backend / apps/frontend / packages/contracts
tests/         ← unit (mocked adapters), integration (real git), e2e (real CLI)
```

Every command receives injected adapters (`CommandContext`); all GitHub
specifics live behind `GitHubAdapter`; all state reporting is pure functions
in `policy.ts`. A dashboard (Electron/web/local server) would import
`core/status.ts` + `core/policy.ts` + an adapter — no CLI code involved. The
JSONL event log provides the streaming seam.

## Development

```sh
npm install
npm test            # build + unit + integration + e2e (124 tests)
npm run test:unit
npm run test:integration
npm pack            # build + package; then install the tarball
```

The CLI's own CI (`.github/workflows/ci.yml`) runs the suite on
Ubuntu + Windows, Node 20 + 22, plus a package-install smoke test that also
greps the tarball for credential-shaped strings.

## License

MIT
