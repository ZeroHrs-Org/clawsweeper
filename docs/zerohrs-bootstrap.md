# ZeroHrs ClawSweeper Bootstrap

This fork is configured for `ZeroHrs-Org/zerohrs-app`.

## Target Repo

The ZeroHrs app repository forwards issue, issue-comment, and pull-request events to this fork with `repository_dispatch`.

Required target repository secret:

- `ZEROHRS_CLAWSWEEPER_GITHUB_TOKEN`

The token needs enough scope to dispatch workflows in this repository and, for the v1 bootstrap model, to read/write issues, branches, and pull requests in `ZeroHrs-Org/zerohrs-app`.

## Runner

ZeroHrs mobile feedback proof should use the target repo's `android-proof` Crabbox job on the static Hetzner SSH host.

Expected target repo artifacts:

- `reports/crabbox-android/proof-manifest.json`
- `reports/crabbox-android/emulator.log`
- `reports/crabbox-android/app.log`
- `reports/crabbox-android/before.png`
- `reports/crabbox-android/after.png`

## Bootstrap Gap

Upstream ClawSweeper is designed around a GitHub App and `openclaw/clawsweeper-state`. The ZeroHrs target profile is in place, but unattended v1 operation still requires converting the issue review, comment-router, and issue-implementation workflows to use `ZEROHRS_CLAWSWEEPER_GITHUB_TOKEN` where upstream currently mints GitHub App installation tokens.
