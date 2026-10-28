#!/usr/bin/env bash
# local-demo.sh — build a throwaway 4-person TeamSync playground on this machine.
# No GitHub account, no gh install needed: GitHub is mocked by a fake `gh`
# executable, and git transport is rewritten to a local bare repository.
#
# Everything lives in /tmp/teamsync-demo. Run this script again any time to
# reset the playground from scratch.
#
# After it finishes, open 4 terminals — one per teammate — and follow the
# printed instructions.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${DEMO:-/tmp/teamsync-demo}"
SLUG="team/tictactoe"

echo "==> 1/5 build + pack + install the CLI into a private prefix"
cd "$REPO"
npm run build >/dev/null
TGZ="$(npm pack 2>/dev/null | tail -1)"
rm -rf "$DEMO/prefix"
npm install -g --prefix "$DEMO/prefix" "./$TGZ" >/dev/null
rm -f "$TGZ"
CLI="$DEMO/prefix/bin/teamsync"

echo "==> 2/5 fake GitHub (a stand-in gh executable; responses are MOCK)"
rm -rf "$DEMO/fakegh" "$DEMO/origin.git" "$DEMO/owner" "$DEMO/home" "$DEMO/seed" "$DEMO/mia" "$DEMO/leo" "$DEMO/ivy" "$DEMO/sam" "$DEMO/merge"
mkdir -p "$DEMO/fakegh" "$DEMO/home"

cat > "$DEMO/fakegh/fake-gh.mjs" <<'SHIM'
#!/usr/bin/env node
// Fake gh for local demos. MOCK GitHub — no network. Reads:
//   TEAMSYNC_FAKE_STATE / TEAMSYNC_FAKE_LOG / TEAMSYNC_FAKE_LOGIN (optional)
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.TEAMSYNC_FAKE_STATE, "utf8"));
const login = process.env.TEAMSYNC_FAKE_LOGIN ?? state.user.login;
appendFileSync(process.env.TEAMSYNC_FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\n");

const fail = (status, msg) => {
  const M = {
    401: "gh: Bad credentials (HTTP 401)",
    403: "gh: Resource not accessible by integration (HTTP 403)",
    404: "gh: Not Found (HTTP 404)",
    422: "gh: JSON: " + JSON.stringify(msg ?? { message: "Validation Failed" }) + " (HTTP 422)",
    429: "gh: API rate limit exceeded (HTTP 429)",
  };
  process.stderr.write(M[status] ?? "gh: error " + status);
  process.exit(1);
};
const ok = (body) => { process.stdout.write(typeof body === "string" ? body : JSON.stringify(body)); process.exit(0); };

function flags(args) {
  const f = { f: {}, F: {}, raw: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f" || args[i] === "-F") {
      const [k, ...v] = args[i + 1].split("=");
      f[args[i] === "-f" ? "f" : "F"][k] = v.join("=");
      i++;
    } else if (args[i] !== "api" && args[i] !== "--paginate" && args[i] !== "--input" && args[i] !== "-") {
      f.raw.push(args[i]);
    }
  }
  return f;
}

const argv = process.argv.slice(2);
if (argv.includes("--version")) ok("gh version 2.0.0-fake\n");
if (argv[0] === "auth") ok("");
if (argv[0] !== "api") fail(404);

let stdinBody = null;
if (argv.includes("--input")) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  stdinBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const fl = flags(argv);
const resource = fl.raw.find((a) => !/^(GET|POST|PATCH|PUT|DELETE)$/.test(a));
const method = argv.includes("--method") ? argv[argv.indexOf("--method") + 1] : "GET";

if (argv.includes("graphql")) {
  const q = fl.f.query ?? "";
  if (q.includes("enablePullRequestAutoMerge")) {
    state.autoMergeEnabled = state.autoMergeEnabled || [];
    state.autoMergeEnabled.push(fl.f.id);
    const pr = (state.prs ?? []).find((p) => p.node_id === fl.f.id);
    if (pr) pr.auto_merge = { enabled_by: { login }, merge_method: (fl.f.m ?? "SQUASH").toLowerCase() };
    writeFileSync(process.env.TEAMSYNC_FAKE_STATE, JSON.stringify(state, null, 2));
    ok({ enablePullRequestAutoMerge: { pullRequest: { number: pr?.number ?? 1 } } });
  }
  if (q.includes("pullRequest(number:")) {
    const pr = (state.prs ?? []).find((p) => p.number === Number(fl.F.num));
    ok({ repository: { pullRequest: pr ? { id: pr.node_id, reviewDecision: null } : null } });
  }
  ok({});
}

if (resource === "user") ok({ ...state.user, login });
if (resource === "rate_limit") ok({});

const m = resource?.match(/^repos\/([^/]+)\/([^/]+)(\/.*)?$/);
if (!m) fail(404);
const tail = m[3] ?? "";

if (tail === "" || tail === undefined || tail === "/merge-queue") ok(state.repo);
if (tail === "/pulls" && method === "POST") {
  const dup = (state.prs ?? []).find((p) => p.head.ref === stdinBody.head && p.state === "open");
  if (dup) fail(422, { message: "pull request already exists for " + stdinBody.head });
  const n = (state.prs?.length ?? 0) + 1;
  const pr = {
    node_id: "PR_" + n, number: n, html_url: "https://github.com/" + state.repo.full_name + "/pull/" + n,
    title: stdinBody.title, state: "open", draft: false, user: { login },
    head: { ref: stdinBody.head, sha: state.headSha ?? "0".repeat(40) },
    base: { ref: stdinBody.base, sha: "1".repeat(40) },
    mergeable: true, mergeable_state: "clean", auto_merge: null,
  };
  state.prs = state.prs ?? []; state.prs.push(pr);
  writeFileSync(process.env.TEAMSYNC_FAKE_STATE, JSON.stringify(state, null, 2));
  ok(pr);
}
if (tail === "/pulls") ok((state.prs ?? []).filter((p) => (fl.f.state ? p.state === fl.f.state : true)));
let pm = tail.match(/^\/pulls\/(\d+)$/);
if (pm) {
  const pr = state.prs?.find((p) => p.number === Number(pm[1]));
  if (!pr) fail(404);
  if (method === "PATCH") Object.assign(pr, stdinBody);
  ok(pr);
}
let cm = tail.match(/^\/commits\/([0-9a-f]+)\/check-runs$/);
if (cm) ok({
  total_count: 1,
  check_runs: [{ name: "integration", head_sha: cm[1], status: "completed", conclusion: "success", html_url: "https://example.invalid/checks" }],
});
let sm = tail.match(/^\/commits\/([0-9a-f]+)\/status$/);
if (sm) ok({ sha: sm[1], statuses: [] });
let bm = tail.match(/^\/branches\/([^/]+)\/protection$/);
if (bm) {
  if (state.protection === null) fail(404);
  ok(state.protection);
}
if (tail === "/actions/workflows") ok({ total_count: 1, workflows: [{ name: "integration" }] });
fail(404);
SHIM

cat > "$DEMO/fakegh/state.json" <<STATE
{
  "user": { "login": "mia", "name": "Mia" },
  "repo": {
    "full_name": "$SLUG", "default_branch": "main", "private": false, "has_issues": true,
    "allow_auto_merge": true, "allow_squash_merge": true, "allow_merge_commit": true,
    "allow_rebase_merge": true, "allow_update_branch": true, "delete_branch_on_merge": true,
    "viewer_permission": "write"
  },
  "prs": [],
  "protection": { "strict": true, "required_status_checks": { "contexts": [], "checks": [{ "context": "integration" }] }, "required_pull_request_reviews": { "required_approving_review_count": 0 } },
  "statuses": []
}
STATE

cat > "$DEMO/fakegh/gh" <<WRAPPER
#!/usr/bin/env bash
export TEAMSYNC_FAKE_STATE="$DEMO/fakegh/state.json"
export TEAMSYNC_FAKE_LOG="$DEMO/fakegh/log.jsonl"
exec node "$DEMO/fakegh/fake-gh.mjs" "\$@"
WRAPPER
chmod +x "$DEMO/fakegh/gh"
: > "$DEMO/fakegh/log.jsonl"

echo "==> 3/5 local bare origin + seed repository"
cat > "$DEMO/gitconfig" <<EOF
[url "file://$DEMO/origin.git"]
	insteadOf = https://github.com/$SLUG.git
EOF
export GIT_CONFIG_GLOBAL="$DEMO/gitconfig" TEAMSYNC_HOME="$DEMO/home" NO_COLOR=1
export GIT_AUTHOR_NAME=owner GIT_AUTHOR_EMAIL=owner@t.local GIT_COMMITTER_NAME=owner GIT_COMMITTER_EMAIL=owner@t.local
git init --bare -q -b main "$DEMO/origin.git"
git -c init.defaultBranch=main init -q "$DEMO/seed"
(
  cd "$DEMO/seed"
  git remote add origin "https://github.com/$SLUG.git"
  echo "# team playground" > README.md
  mkdir -p apps/backend apps/frontend services packages/contracts tests
  echo "shared contracts live here" > packages/contracts/README.md
  git add . && git commit -qm "initial repository" && git push -q origin main
)

echo "==> 4/5 owner clone + teamsync init (setup PR merged automatically)"
git clone -q "https://github.com/$SLUG.git" "$DEMO/owner"
git -C "$DEMO/owner" config user.name owner
git -C "$DEMO/owner" config user.email owner@t.local
cd "$DEMO/owner"
"$CLI" --gh-path "$DEMO/fakegh/gh" init --repo "$SLUG" --yes >/dev/null
SETUP_BRANCH="$(git ls-remote --heads origin | grep -o 'teamsync/setup/[^	]*' | sed 's#refs/heads/##' | head -1)"
git fetch -q origin
git checkout -q main
git merge -q --no-ff "origin/$SETUP_BRANCH" -m "Merge setup PR (admin)"   # simulate GitHub merging it
git push -q origin main

echo "==> 5/5 four teammate clones, one per role"
for entry in "mia services" "leo backend" "ivy frontend" "sam qa"; do
  set -- $entry
  name="$1"; role="$2"
  git clone -q "https://github.com/$SLUG.git" "$DEMO/$name"
  git -C "$DEMO/$name" config user.name "$name"
  git -C "$DEMO/$name" config user.email "$name@t.local"
  "$CLI" --gh-path "$DEMO/fakegh/gh" join "$SLUG" --role "$role" --path "$DEMO/$name" >/dev/null
done

# One shared CLI wrapper OUTSIDE the clones (kept out so worktrees stay clean).
# It picks the mock GitHub identity from the directory you stand in.
cat > "$DEMO/ts" <<TS
#!/usr/bin/env bash
# Run me from inside one of the teammate clones:
#   cd $DEMO/mia && ../ts status
export GIT_CONFIG_GLOBAL="$DEMO/gitconfig"
export TEAMSYNC_HOME="$DEMO/home"
export NO_COLOR=1
case "\$(basename "\$PWD")" in
  mia|leo|ivy|sam) export TEAMSYNC_FAKE_LOGIN="\$(basename "\$PWD")" ;;
esac
exec "$CLI" --gh-path "$DEMO/fakegh/gh" "\$@"
TS
chmod +x "$DEMO/ts"

# Helper: simulate GitHub auto-merging a PR (run from anywhere inside $DEMO).
cat > "$DEMO/merge" <<MERGE
#!/usr/bin/env bash
# usage: merge <branch-name-substring>   e.g. merge homepage
set -euo pipefail
export GIT_CONFIG_GLOBAL="$DEMO/gitconfig"
cd "$DEMO/owner"
git fetch -q --prune origin
git checkout -q main
git merge -q --ff-only origin/main 2>/dev/null || true
BRANCH="\$(git ls-remote --heads origin | grep -o 'refs/heads/[^	]*' | sed 's#refs/heads/##' | grep "\$1" | head -1)"
[ -n "\$BRANCH" ] || { echo "no remote branch matches: \$1"; exit 1; }
git merge -q --no-ff "origin/\$BRANCH" -m "Merge PR: \$BRANCH (auto-merge simulated)"
git push -q origin main
echo "GitHub (simulated) merged: \$BRANCH"
MERGE
chmod +x "$DEMO/merge"

echo ""
echo "Playground ready in $DEMO"
echo ""
echo "Open 4 terminals — one per teammate:"
echo "  cd $DEMO/mia   # services role"
echo "  cd $DEMO/leo   # backend role"
echo "  cd $DEMO/ivy   # frontend role"
echo "  cd $DEMO/sam   # qa role"
echo ""
echo "In each, run teamsync through the shared wrapper (it knows who you are from the folder):"
echo "  ../ts doctor"
echo "  ../ts start my-task        # then edit files in any editor"
echo "  ../ts submit --all -m \"my change\""
echo "  ../ts status"
echo "  ../ts sync"
echo ""
echo "To simulate GitHub auto-merging a PR after its checks pass (from anywhere):"
echo "  $DEMO/merge <branch-name-substring>"
echo ""
echo "Full reset any time: re-run $0"
