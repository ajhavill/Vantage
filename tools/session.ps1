# Vantage multi-session helper — isolate concurrent Claude sessions via git worktrees.
# See CLAUDE.md for the full protocol.
#
#   pwsh tools/session.ps1 list           # who's working on what (worktrees + session branches)
#   pwsh tools/session.ps1 new <topic>    # create an isolated worktree + session/<topic> branch
#   pwsh tools/session.ps1 done <topic>   # print the push / PR / cleanup steps

param(
  [Parameter(Position = 0)][string]$Cmd = "list",
  [Parameter(Position = 1)][string]$Topic
)
$ErrorActionPreference = "Stop"

switch ($Cmd) {
  "list" {
    Write-Host "== Active session worktrees ==" -ForegroundColor Cyan
    git worktree list
    Write-Host "`n== Session branches ==" -ForegroundColor Cyan
    git branch -vv | Select-String "session/"
  }
  "new" {
    if (-not $Topic) { throw "Usage: session.ps1 new <topic>" }
    git fetch origin main --quiet
    git worktree add "../Vantage-$Topic" -b "session/$Topic" origin/main
    Write-Host "`nIsolated worktree ready. Next:" -ForegroundColor Green
    Write-Host "  cd ../Vantage-$Topic"
  }
  "done" {
    if (-not $Topic) { throw "Usage: session.ps1 done <topic>" }
    Write-Host "Ship 'session/$Topic':" -ForegroundColor Green
    Write-Host "  git push -u origin session/$Topic"
    Write-Host "  gh pr create --base main --head session/$Topic   # or open the PR in GitHub"
    Write-Host "After it merges, clean up:" -ForegroundColor Green
    Write-Host "  git worktree remove ../Vantage-$Topic"
    Write-Host "  git branch -d session/$Topic"
  }
  default { throw "Unknown command '$Cmd'. Use: list | new <topic> | done <topic>" }
}
