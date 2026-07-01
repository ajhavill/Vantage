# Working in this repo with multiple concurrent Claude sessions

Andrew frequently runs **several Claude Code sessions against this repo at the same time**
(e.g. one on the tenant-intelligence module, one on the occupancy/comps modeler). If they
share a working tree they step on each other. This already caused a real incident: a
`git push` from one session shipped **another session's committed-but-unpushed work** to
`main` — and therefore to the live Netlify deploy — because `push` sends every commit an
ancestor of your `HEAD`, not just "your" commit.

To keep every session **isolated** and **aware of the others**, follow this protocol.

## 1. Orient first (awareness) — before you touch anything
These commands are the source of truth for "who is doing what". Run them at the start of
every session:

```
git worktree list      # every active session workspace + the branch it's on
git branch -vv          # local branches — named session/<topic> per this protocol
git status              # uncommitted work in THIS worktree
git log --oneline -8    # what has landed recently
```

If `git status` shows changes you didn't make, **another session is working in this
folder** — do not stage or commit broadly, and prefer moving to your own worktree (step 2).

## 2. Isolation — one worktree + one branch per session
**Never work directly on `main`.** Give each session its own git *worktree* (a separate
folder) on its own branch, so file edits and commit history can't collide:

```
# from the main repo folder:
git worktree add ../Vantage-<topic> -b session/<topic> origin/main
cd ../Vantage-<topic>
```

Do all your work there. `main` stays clean; your commits live on `session/<topic>`.
Helper: `pwsh tools/session.ps1 new <topic>` does this for you (`list` / `done` too).

## 3. Committing & shipping — never sweep in another session's work
- **Stage explicit paths**: `git add path/to/file`. Never `git add -A` / `git add .` /
  `git commit -a` — those grab whatever else is in the tree, including other sessions' files.
- **Push only your branch**: `git push -u origin session/<topic>`.
- **Integrate through a PR into `main`.** `main` auto-deploys on Netlify, so only merge
  deploy-ready work. Pushing straight to `main` from a shared tree is what caused the
  incident — don't do it.
- Working from your own worktree makes this safe automatically: a stale push is *rejected*
  (non-fast-forward) instead of silently carrying someone else's commits out.

## 4. When your work is merged, clean up
```
git worktree remove ../Vantage-<topic>
git branch -d session/<topic>
```

## TL;DR
Orient (`git worktree list`) → your own worktree on a `session/<topic>` branch → explicit
`git add` → push your branch → PR into `main`. **`main` is sacred and auto-deploys.**
