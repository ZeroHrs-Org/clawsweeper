# ZeroHrs ClawSweeper Bootstrap

This fork is configured for `ZeroHrs-Org/zerohrs-app`.

## Target Repo

The ZeroHrs app repository forwards issue, issue-comment, and pull-request events to this fork with `repository_dispatch`.

Required target repository secret:

- `ZEROHRS_CLAWSWEEPER_GITHUB_TOKEN`

The token needs enough scope to dispatch workflows in this repository and, for the v1 bootstrap model, to read/write issues, branches, and pull requests in `ZeroHrs-Org/zerohrs-app`.

Required ClawSweeper repository secrets for Android proof:

- `ZEROHRS_CLAWSWEEPER_GITHUB_TOKEN`
- `HETZNER_IPV4`
- `ZEROHRS_HETZNER_CRABBOX_PRIVATE_KEY`
- `ZEROHRS_HETZNER_KNOWN_HOSTS`
- `ZEROHRS_TEST_EMAIL`
- `ZEROHRS_TEST_PASSWORD`

Optional ClawSweeper repository secret:

- `ZEROHRS_ANDROID_GOOGLE_SERVICES_JSON_B64`

## Runner

ZeroHrs mobile feedback proof should use the target repo's `android-proof` Crabbox job on the static Hetzner SSH host.

Android proof may sign in with the public ZeroHrs test account:

- `sid@zerohrs.com`
- `Cooking@9098`

Expected target repo artifacts:

- `reports/crabbox-android/proof-manifest.json`
- `reports/crabbox-android/emulator.log`
- `reports/crabbox-android/app.log`
- `reports/crabbox-android/before.png`
- `reports/crabbox-android/after.png`

## Bootstrap Gap

Upstream ClawSweeper is designed around a GitHub App and `openclaw/clawsweeper-state`. The ZeroHrs target profile is in place, but unattended v1 operation still requires converting the issue review, comment-router, and issue-implementation workflows to use `ZEROHRS_CLAWSWEEPER_GITHUB_TOKEN` where upstream currently mints GitHub App installation tokens.
