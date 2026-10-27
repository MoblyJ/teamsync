# Live verification checklist (requires a real GitHub repository)

The automated suite covers everything verifiable offline: real local git
repositories (branch uniqueness, PR reuse, conflict aborts, dirty-tree
refusals, push-rejection safety) and GitHub behavior mocked strictly at the
adapter boundary (check-state classification, stale detection, auto-merge
enrollment, error mapping).

**What the suite cannot prove offline** is GitHub's server-side enforcement.
This checklist is the exact manual procedure to verify live automatic merging
in an authorized **disposable** repository. Nothing below may be assumed from
the offline tests; until it is run, live auto-merge behavior is UNVERIFIED.

## Setup (once, ~10 minutes)

1. Create a throwaway repository, e.g. `YOURNAME/teamsync-live-test` (public
   keeps everything free; delete it afterwards).
2. Push the demo app (`demo/` contents) or any small codebase.
3. `teamsync init --repo YOURNAME/teamsync-live-test`, merge the setup PR.
4. In repository Settings apply:
   - [ ] General → Pull Requests → **Allow auto-merge** ✅
   - [ ] Branches → protect `main`: require check **`integration`**,
     ✅ require branches to be up to date before merging
   - [ ] Actions → General → default workflow permissions: **Read** only
5. `teamsync doctor --repo YOURNAME/teamsync-live-test` → all green
   (branch-protection row readable only if you are admin — you are, here).

## Verify: compatible changes merge automatically

6. Teammate A (role `frontend`): `teamsync start page-a`, edit
   `apps/frontend/**`, `teamsync submit --all -m "A"`.
7. Teammate B (role `backend`): `teamsync start api-b`, edit
   `apps/backend/**`, `teamsync submit --all -m "B"` — while A's PR is still
   checking.
8. Expected, on A's PR:
   - [ ] `teamsync status` shows `checks-pending`, then
         `auto-merge-requested` (checkbox "enable auto-merge" visible on the
         PR page, checked).
   - [ ] When `integration` goes green, **GitHub merges A automatically**;
         no CLI process needs to be running at that moment (close `watch`).
9. After A merges, B's PR:
   - [ ] shows `behind`/`NEEDS SYNC` (up-to-date requirement), then
   - [ ] after `teamsync sync` + `teamsync submit`, fresh checks run against
         the new base and B auto-merges.
   - [ ] **Critical**: B's push did NOT inherit A's green checks — verify on
         the PR page that the check runs' commit SHA equals B's head SHA.

## Verify: conflicts stay blocked

10. A and B both edit the same line of
    `packages/contracts/contracts.mjs` on separate task branches; both submit.
11. Expected:
    - [ ] The second PR reports `conflict` in `teamsync status`; auto-merge
          does NOT fire; the PR stays open.
    - [ ] On the conflicting clone, `teamsync sync` lists the file, aborts,
          and leaves the worktree byte-identical (`git status` clean,
          `git diff HEAD` empty).
    - [ ] Manual resolution (`git merge origin/main`, fix, commit, push)
          updates the SAME PR and then auto-merges.

## Verify: failure and review semantics

12. Break the backend test on a task branch and submit:
    - [ ] `checks-failed` state; no auto-merge; PR open.
13. Add a required review (branch settings → require 1 approval):
    - [ ] PR with no approval shows `needs-review` even with green checks;
          an approval lets auto-merge proceed (then remove the rule).
14. In the Actions run for a PR touching ONLY `apps/frontend/**`:
    - [ ] backend/services jobs are skipped, `integration` still runs and
          passes (aggregate gate), and the PR merges — this proves skipped
          path-filtered jobs don't block and the aggregate check is what's
          required.

## Verify: manual merge mode fallback

15. Temporarily uncheck **Allow auto-merge**, submit a PR:
    - [ ] `teamsync submit`/`status` report **manual merge mode** explicitly;
          the PR is open and untouched; no CLI error.
16. Re-enable the setting.

## Known-unverifiable offline items this checklist covers

- GitHub-native auto-merge firing server-side (with no watcher).
- Up-to-date/strict recheck after base movement.
- Required-check enforcement including skipped-job semantics.
- Merge queue behavior (optional: enable a queue on the branch rule and
  confirm TeamSync reports queue mode; a paid plan is required for private
  repos — skip if unavailable and note it).
