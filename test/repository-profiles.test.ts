import assert from "node:assert/strict";
import test from "node:test";

import { REPOSITORY_PROFILES, repositoryProfileFor } from "../dist/repository-profiles.js";

test("repositoryProfileFor matches mixed-case input against canonical profiles", () => {
  const profile = repositoryProfileFor("OpenClaw/ClawHub");

  assert.equal(profile.targetRepo, "openclaw/clawhub");
  assert.equal(profile.slug, "openclaw-clawhub");
  assert.deepEqual(profile.applyCloseRules.issue, ["implemented_on_main"]);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
  ]);
});

test("repositoryProfileFor supports fs-safe event reviews", () => {
  const profile = repositoryProfileFor("OpenClaw/fs-safe");

  assert.equal(profile.targetRepo, "openclaw/fs-safe");
  assert.equal(profile.slug, "openclaw-fs-safe");
  assert.equal(profile.checkoutDir, "fs-safe");
  assert.deepEqual(profile.applyCloseRules.issue, ["implemented_on_main"]);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
  ]);
});

test("ZeroHrs feedback profile treats maintainer-authored reports as external feedback", () => {
  const profile = repositoryProfileFor("ZeroHrs-Org/zerohrs-app");

  assert.equal(profile.targetRepo, "zerohrs-org/zerohrs-app");
  assert.match(profile.promptNote, /labels\/body\/admin metadata indicate a feedback report/);
  assert.match(profile.promptNote, /external user report/);
  assert.match(profile.promptNote, /GitHub issue author is a ZeroHrs maintainer/);
  assert.match(profile.promptNote, /prefer Android Crabbox proof/);
  assert.match(profile.promptNote, /test credentials from configured secrets/);
  assert.match(profile.promptNote, /ZEROHRS_TEST_EMAIL/);
  assert.match(profile.promptNote, /ZEROHRS_TEST_PASSWORD/);
  assert.match(profile.promptNote, /without printing or committing their raw values/);
  assert.match(profile.promptNote, /Missing local adb, emulator, or ffmpeg/);
  assert.match(profile.promptNote, /not a proof blocker/);
  assert.match(profile.promptNote, /configured Crabbox SSH runner/);
  assert.doesNotMatch(profile.promptNote, /public ZeroHrs test account/);
  assert.match(
    profile.promptNote,
    /During planning\/review, collect current-state reproduction artifacts only/,
  );
  assert.match(profile.promptNote, /executor agent decides the issue-specific reproduction path/);
  assert.match(profile.promptNote, /inside the target checkout/);
  assert.match(profile.promptNote, /external \/tmp-only proof is not publishable/);
  assert.match(profile.promptNote, /reports\/clawsweeper\/android-proof/);
  assert.match(profile.promptNote, /Do not hardcode one issue's path into shared proof scripts/);
  assert.match(profile.promptNote, /do not leave edits to scripts\/crabbox\/android-proof\.sh/);
  assert.match(profile.promptNote, /before-loading\.png/);
  assert.match(profile.promptNote, /before\.mp4/);
  assert.match(profile.promptNote, /seed or mock data in the local dev\/test database/);
  assert.deepEqual(profile.applyCloseRules.issue, ["implemented_on_main"]);
});

test("generic OpenClaw fallback supports conservative event-only onboarding", () => {
  const profile = repositoryProfileFor("OpenClaw/example-tool");

  assert.equal(profile.targetRepo, "openclaw/example-tool");
  assert.equal(profile.slug, "openclaw-example-tool");
  assert.equal(profile.displayName, "example-tool");
  assert.equal(profile.checkoutDir, "example-tool");
  assert.match(profile.promptNote, /generic OpenClaw onboarding profile/);
  assert.match(profile.promptNote, /current default branch/);
  assert.deepEqual(profile.applyCloseRules.issue, ["implemented_on_main"]);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
  ]);
});

test("generic steipete fallback starts review-only", () => {
  const profile = repositoryProfileFor("Steipete/example-tool");

  assert.equal(profile.targetRepo, "steipete/example-tool");
  assert.equal(profile.slug, "steipete-example-tool");
  assert.equal(profile.displayName, "example-tool");
  assert.equal(profile.checkoutDir, "example-tool");
  assert.match(profile.promptNote, /generic personal-repository onboarding profile/);
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("generic OpenClaw fallback keeps denied repositories unsupported", () => {
  assert.throws(
    () => repositoryProfileFor("openclaw/clawsweeper-state"),
    /Unsupported target repo: openclaw\/clawsweeper-state/,
  );
});

test("generic fallback does not support repositories outside configured owners", () => {
  assert.throws(
    () => repositoryProfileFor("other-org/example-tool"),
    /Unsupported target repo: other-org\/example-tool/,
  );
});

test("profile lookup normalizes candidate target repos as well as input", () => {
  const mixedCaseProfile = {
    ...REPOSITORY_PROFILES[0],
    targetRepo: "Example-Org/Mixed-Case-Repo",
    slug: "example-org-mixed-case-repo",
  };
  REPOSITORY_PROFILES.push(mixedCaseProfile);

  try {
    assert.equal(repositoryProfileFor("example-org/mixed-case-repo"), mixedCaseProfile);
    assert.equal(repositoryProfileFor("EXAMPLE-ORG/MIXED-CASE-REPO"), mixedCaseProfile);
  } finally {
    REPOSITORY_PROFILES.pop();
  }
});
