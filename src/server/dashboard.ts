// The built-in dashboard page, served at GET / by `teamsync serve`.
// Kept as a string so it ships inside dist/ with zero build steps or
// external assets. Status always pairs an icon with a label — never color
// alone; text uses ink tokens; light/dark via prefers-color-scheme.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamSync — local dashboard</title>
<style>
  :root {
    --bg: #f6f7f9; --surface: #ffffff; --ink: #16191d; --ink-2: #4d5661; --ink-3: #7a828c;
    --line: #d9dee4; --good: #1a7f37; --pending: #9a6700; --serious: #c0392b; --accent: #0969da;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --surface: #161b22; --ink: #e6edf3; --ink-2: #b1bac4; --ink-3: #7d8590;
      --line: #30363d; --good: #3fb950; --pending: #d29922; --serious: #f85149; --accent: #4493f8;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  header { padding: 14px 22px; border-bottom: 1px solid var(--line); display: flex; gap: 10px; align-items: baseline; }
  header h1 { font-size: 16px; margin: 0; }
  header .sub { color: var(--ink-3); font-size: 12px; }
  #conn { font-size: 12px; margin-left: auto; }
  main { padding: 18px 22px; max-width: 980px; }
  .team { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; }
  .team h2 { font-size: 15px; margin: 0 0 2px; }
  .team .meta { color: var(--ink-2); font-size: 12px; margin-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: left; color: var(--ink-3); font-weight: 500; font-size: 12px; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); }
  td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .chip { white-space: nowrap; font-size: 12px; }
  .chip::before { margin-right: 4px; }
  .good { color: var(--good); } .good::before { content: "●"; }
  .pending { color: var(--pending); } .pending::before { content: "◐"; }
  .serious { color: var(--serious); } .serious::before { content: "✖"; }
  .muted { color: var(--ink-3); }
  .prs h3 { font-size: 13px; margin: 12px 0 4px; color: var(--ink-2); }
  .empty { color: var(--ink-3); font-style: italic; }
  button { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--line);
           background: var(--surface); color: var(--ink); cursor: pointer; }
  button:hover { border-color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>TeamSync</h1><span class="sub">local team dashboard</span>
  <span id="conn" class="muted">connecting…</span>
</header>
<main id="main"><p class="empty">loading…</p></main>
<script>
const stateChip = (s) => {
  const cls = /conflict|checks-failed|blocked/.test(s) ? "serious"
    : /auto-merge-requested|merged/.test(s) ? "good"
    : /manual-mode|draft|unknown/.test(s) ? "muted" : "pending";
  const label = s.replace(/-/g, " ");
  return '<span class="chip ' + cls + '">' + label + "</span>";
};
const age = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  return s < 60 ? Math.round(s) + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago"
       : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
};
async function refresh() {
  try {
    const r = await fetch("/api/teams"); const data = await r.json();
    document.getElementById("conn").textContent = "live";
    const main = document.getElementById("main");
    if (!data.teams.length) {
      main.innerHTML = '<p class="empty">No teams yet. Run: <code>teamsync team create &lt;name&gt;</code></p>';
      return;
    }
    main.innerHTML = "";
    for (const t of data.teams) {
      const el = document.createElement("section"); el.className = "team";
      el.innerHTML =
        "<h2>" + t.displayName + "</h2>" +
        '<div class="meta">admin ' + t.admin + " · " + t.memberCount + " member(s) · created " + age(t.createdAt) +
        (t.repository ? " · repo <code>" + t.repository + "</code>" : "") + "</div>" +
        "<table><thead><tr><th>login</th><th>role</th><th>last seen</th><th>joined</th></tr></thead><tbody>" +
        t.members.map((m) =>
          "<tr><td>" + m.login + (m.login === t.admin ? ' <span class="muted">(admin)</span>' : "") +
          "</td><td>" + m.role + "</td><td>" + age(m.lastSeen) + "</td><td>" + age(m.joinedAt) + "</td></tr>"
        ).join("") + "</tbody></table>" +
        (t.repository ? '<div class="prs" data-repo="' + t.repository + '"><h3>open team PRs</h3><p class="empty">loading…</p></div>' : "");
      main.appendChild(el);
      const prBox = el.querySelector(".prs");
      if (prBox) loadPRs(prBox, t.repository);
    }
  } catch {
    document.getElementById("conn").textContent = "server unreachable";
  }
}
async function loadPRs(box, repo) {
  try {
    const r = await fetch("/api/repos/" + repo + "/status");
    const d = await r.json();
    if (!r.ok) { box.innerHTML = "<h3>open team PRs</h3><p class='empty'>" + (d.error?.message || "unavailable") + "</p>"; return; }
    if (!d.prs.length) { box.innerHTML = "<h3>open team PRs</h3><p class='empty'>none open</p>"; return; }
    box.innerHTML = "<h3>open team PRs</h3><table><thead><tr><th>#</th><th>title</th><th>author</th><th>state</th><th>head → base</th></tr></thead><tbody>" +
      d.prs.map((p) => "<tr><td>" + p.number + "</td><td>" + p.title + "</td><td>" + p.author +
        (p.mine ? " (you)" : "") + "</td><td>" + stateChip(p.state) +
        "</td><td><code>" + p.branch + " → " + p.baseBranch + "</code></td></tr>").join("") +
      "</tbody></table>";
  } catch { box.innerHTML = "<h3>open team PRs</h3><p class='empty'>unavailable</p>"; }
}
refresh();
setInterval(refresh, 5000);
try {
  const es = new EventSource("/api/events");
  es.onmessage = () => refresh();
  es.onerror = () => { document.getElementById("conn").textContent = "reconnecting…"; };
} catch {}
</script>
</body>
</html>
`;
