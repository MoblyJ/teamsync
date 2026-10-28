# TeamSync Manual

Complete command list, features, and usage guide. Everything runs from a
terminal after `npm install -g @YOUR_SCOPE/teamsync` (or from the local
tarball during development). For AI-assisted usage see "Vibe mode".

---

## 1. Install & first run

Installing triggers **first-run setup** automatically:

- `gh` not installed → asks **y/N** → installs it (may prompt for your
  sudo/admin password; uses apt/brew/winget per platform)
- `gh` installed but not logged in → offers **`gh auth login`** (browser or
  device code — your token stays inside gh)
- everything ready → prints one line and leaves it be

Rules: setup never blocks or fails the install; in CI/non-interactive shells
it skips with printed hints; opt out with `TEAMSYNC_NO_SETUP=1`. Check status
anytime with `teamsync doctor`.

Prerequisites: Node ≥ 20, git ≥ 2.30, gh. Platforms: Windows PowerShell,
macOS, Linux, WSL (install gh inside the WSL distro).

---

## 2. Command reference (all 20)

### Setup & account
| Command | What it does |
| --- | --- |
| `teamsync doctor` | check runtime, git, gh, login, repo access, CI, auto-merge prerequisites; explains fixes, installs nothing |
| `teamsync login` | GitHub login via `gh auth login`; also wires git push/pull auth |
| `teamsync logout` | remove the gh login **after confirmation** (it is shared with other gh tools) |

### Repository onboarding (run once per repo)
| Command | What it does |
| --- | --- |
| `teamsync init --repo OWNER/REPO` | owner only: create a setup PR with shared config, PR template, CI gate, contracts folder; preserves existing files; prints the exact admin settings needed |
| `teamsync join OWNER/REPO --role ROLE` | clone safely (or adopt an existing clone), validate access + shared config, store your role locally |

### Daily work — one-shot mode
| Command | What it does |
| --- | --- |
| `teamsync start TASK` | clean tree required; creates unique `teamsync/<login>/<role>/<task>-<suffix>` from latest main |
| `teamsync submit -m "MSG" [--all \| --paths …]` | stage → commit → push → create/update the ONE PR → enroll auto-merge → report true state. Idempotent (retries never duplicate PRs/commits) |
| `teamsync status [--all] [--json]` | everyone's PRs: roles, checks, conflicts, merge eligibility, blockers |
| `teamsync watch [-i N]` | poll status live; Ctrl+C stops; server-side merging never needs it |
| `teamsync sync` | default branch: fast-forward only; task branch: merge updated base; refuses dirty trees; conflicts abort cleanly with file list |

### Daily work — step-by-step mode (same rails)
| Command | What it does |
| --- | --- |
| `teamsync stage --all \| --paths …` | stage explicitly; excludes likely secret files (.env, keys…); warns on cross-role/shared paths |
| `teamsync commit -m "MSG"` | commit what is staged |
| `teamsync push` | push the task branch (never force-pushes; refuses non-task branches) |

### Team server & dashboard
| Command | What it does |
| --- | --- |
| `teamsync serve [-p PORT]` | run the local team server: REST + SSE + dashboard at http://localhost:4700; state persists in `.teamsync-server.json` |
| `teamsync team create NAME` | create a team → you are admin; prints the one-time join code |
| `teamsync team join NAME --role R --code C` | join with the code as a normal member |
| `teamsync team list \| info NAME` | rosters, roles, admins, last-seen |
| `teamsync team code/rotate-code NAME` | show / regenerate the join code (admin only) |
| `teamsync team remove-member NAME LOGIN` | admin only |
| `teamsync team repo NAME OWNER/REPO` | point the team's dashboard at a repo (admin only) |
| `teamsync team leave \| delete NAME` | leave as member / delete as admin |
| `teamsync team heartbeat NAME` | refresh your "last seen" |
| `teamsync team discover` | find servers on the LAN (UDP) |

### AI / integrations
| Command | What it does |
| --- | --- |
| `teamsync mcp` | MCP server over stdio — see §5 |
| `--json` / `--events FILE` | machine-readable output / JSONL event stream (any command) |

---

## 3. Feature summary

- **Role-aware collaboration** — services/backend/frontend/qa (or custom
  roles in `.teamsync/config.json`); ownership is advisory: warnings, never
  blocks. Shared paths (contracts, lockfiles, workflows) are highlighted.
- **Automatic merging, safely** — GitHub-native auto-merge per PR, only
  after required checks pass and the branch is up to date. Skipped/stale
  checks are never counted as success. Conflicts stay blocked for humans.
  No force-push, no rewrites, no silent stashing — ever.
- **Secret protection** — `.env`, `*.pem`, `id_rsa`, credential stores…
  never staged by `--all`; naming one explicitly is a hard stop.
- **Team server + dashboard** — any number of teams/members; creator =
  admin (join-code gated); live roster + PR dashboard on localhost or LAN;
  works across networks/mobile data via a tunnel (cloudflared/ngrok).
- **Two driving modes** — manual commands and MCP for AI tools; identical
  safety rails.
- **Structured output** — `--json` everywhere relevant; JSONL events feed a
  future hosted dashboard.

## 4. Usage guide — the happy path

**Owner, once:**
```sh
teamsync doctor && teamsync login
git clone OWNER/REPO && cd REPO
teamsync init --repo OWNER/REPO        # merge the setup PR, apply the printed settings
```

**Each teammate, once:**
```sh
teamsync doctor && teamsync login
teamsync join OWNER/REPO --role frontend
cd REPO
```

**Every day (per task):**
```sh
teamsync start homepage
# …edit files in any editor…
teamsync submit --all -m "Add homepage"
teamsync status            # or: teamsync watch
teamsync sync              # when main moved under you; resolve conflicts if listed, then submit again
```

**Team dashboard:**
```sh
teamsync serve                                   # host machine
teamsync team create hack-night                  # → join code
teamsync team repo hack-night OWNER/REPO         # PRs on the dashboard
# teammates: teamsync team join hack-night --role qa --code CODE --server http://host:4700
# browser: http://localhost:4700 (host) or http://<host-ip>:4700 (LAN)
```

## 5. Vibe mode (AI tools)

Add to Claude Code / Claude Desktop / Cursor / any MCP client:
```json
{ "mcpServers": { "teamsync": { "command": "teamsync", "args": ["mcp"] } } }
```
Nine tools (`teamsync_doctor/start/stage/commit/push/submit/status/sync/team_list`)
mirror the CLI; failures return the same hints so the AI self-corrects.
Details: `docs/mcp-claude-code.md`.

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| setup didn't run / CI install | non-interactive by design; run `teamsync doctor`, then `gh auth login` |
| `sudo` install failed | your distro may lack the gh package — follow https://cli.github.com/ |
| 401 on any command | `teamsync login` again |
| push auth fails | `gh auth setup-git` |
| PR stuck `checks-blocked` | a required check never ran or was skipped — use the aggregate `integration` job from the template |
| PR `behind` | `teamsync sync` then `teamsync submit` |
| conflict | `teamsync sync` lists files; resolve, commit merge, submit |
| dashboard unreachable from phone/other network | tunnel the server: `cloudflared tunnel --url http://localhost:4700` |
| config version error | update the CLI |

Exit codes: 0 ok · 1 general · 2 usage · 3 blocked/conflict · 4 auth ·
5 network/rate-limit · 6 not found · 7 bad config · 8 capability missing.
