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

ZeroHrs mobile feedback review can use the target repo's legacy `android-proof` Crabbox job on the static Hetzner SSH host to capture current-state reproduction evidence before planning. This review evidence is not after-fix proof.

Implementation proof is owned by the executor coding agent. The agent should decide the issue-specific Android reproduction path, seed or mock any needed local dev/test data, capture current-main `before-*` media and fixed-branch `after-*` media, then save the result under `reports/clawsweeper/android-proof` inside the target checkout. ClawSweeper only collects and publishes that executor-owned checkout directory, so proof left only under `/tmp` or `.crabbox/runs` is not publishable.

If a billing, onboarding, entitlement, referral, or account gate blocks the reported screen, the executor may create and use local admin/referral codes, local trial/plan state, or other minimal local account state needed to reach the real app route. The proof artifacts must document the code type, seed commands, and seeded state. Never use production data for this setup.

Issue implementation PRs must not carry one-off edits to the reusable proof harness. Keep `scripts/crabbox/android-proof.sh`, `scripts/crabbox/run-android-proof.sh`, their tests, and `docs/crabbox-hetzner-feedback.md` generic; issue-specific proof decisions belong in the executor's commands, logs, manifest, and saved media.

Android proof should read test-account credentials from repository secrets such as `ZEROHRS_TEST_EMAIL` and `ZEROHRS_TEST_PASSWORD`; do not hardcode them in prompts, docs, or scripts.

Expected executor proof artifacts:

- `reports/clawsweeper/android-proof/proof-manifest.json`
- `reports/clawsweeper/android-proof/command.log`
- `reports/clawsweeper/android-proof/emulator.log`
- `reports/clawsweeper/android-proof/app.log`
- `reports/clawsweeper/android-proof/before-loading.png`
- `reports/clawsweeper/android-proof/before.mp4`
- `reports/clawsweeper/android-proof/after-loading.png`
- `reports/clawsweeper/android-proof/after.mp4`
- `reports/clawsweeper/android-proof/before.png`
- `reports/clawsweeper/android-proof/after.png`

## Bootstrap Gap

Upstream ClawSweeper is designed around a GitHub App and `openclaw/clawsweeper-state`. The ZeroHrs target profile is in place, but unattended v1 operation still requires converting the issue review, comment-router, and issue-implementation workflows to use `ZEROHRS_CLAWSWEEPER_GITHUB_TOKEN` where upstream currently mints GitHub App installation tokens.
