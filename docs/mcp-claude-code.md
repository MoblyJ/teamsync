# Connecting AI tools to TeamSync (MCP)

TeamSync ships a built-in MCP server (`teamsync mcp`, stdio transport) so AI
coding tools can drive the whole flow — vibe mode. Manual mode needs nothing:
the same commands work in a terminal.

## Claude Code (this repository)

`.mcp.json` is already committed:

```json
{
  "mcpServers": {
    "teamsync": {
      "command": "node",
      "args": ["bin/teamsync.js", "mcp"],
      "env": {}
    }
  }
}
```

After adding it, Claude Code offers the tools on the next start (or run
`/mcp` to check). Ask for things like *"use teamsync_start, then edit the
homepage, then teamsync_submit"*.

## Claude Code / Claude Desktop (installed globally)

```json
{
  "mcpServers": {
    "teamsync": {
      "command": "teamsync",
      "args": ["mcp"]
    }
  }
}
```

Claude Desktop: put the same clause in `claude_desktop_config.json`
(Settings → Developer → Edit Config). Launch per-project so the tools act on
the right clone, or set the working directory to your clone.

## Other MCP clients (Cursor, Windsurf, …)

Any client that supports stdio MCP servers: command `teamsync`, args `["mcp"]`.

## Tools exposed (9)

| Tool | What it does |
| --- | --- |
| `teamsync_doctor` | check prerequisites, explain problems |
| `teamsync_start` | create the unique task branch |
| `teamsync_stage` | stage changes (secret-excluding, role-aware) |
| `teamsync_commit` | commit staged changes |
| `teamsync_push` | push the task branch |
| `teamsync_submit` | stage+commit+push+PR+auto-merge in one idempotent call |
| `teamsync_status` | team PRs, checks, conflicts, blockers |
| `teamsync_sync` | safe update from the default branch |
| `teamsync_team_list` | rosters on the team server |

Team tools read `TEAMSYNC_SERVER` (or the last used server) from the
environment of the MCP process — add it to the `env` block if your team
server runs elsewhere:

```json
"env": { "TEAMSYNC_SERVER": "https://your-tunnel.example.com" }
```

Failures return `isError: true` with the same actionable hints the CLI
prints, so the AI can self-correct ("worktree dirty → commit first").
