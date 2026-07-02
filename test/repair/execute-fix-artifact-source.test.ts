import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("no-op automerge repair updates outcome and re-enters router before exit", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const noPlannedBranch = source.match(
    /if \(plannedFixActions\.length === 0\) \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;

  assert.ok(noPlannedBranch, "expected no planned fix actions branch");
  assert.match(noPlannedBranch, /report\.reason = "no planned fix actions";/);

  const continuationIndex = noPlannedBranch.indexOf(
    "appendAutomergeRepairOutcomeComment(report, resultPath);",
  );
  const writeReportIndex = noPlannedBranch.indexOf("writeReport(report, resultPath);");
  const exitIndex = noPlannedBranch.indexOf("process.exit(0);");

  assert.notEqual(continuationIndex, -1);
  assert.notEqual(writeReportIndex, -1);
  assert.notEqual(exitIndex, -1);
  assert.ok(
    continuationIndex < writeReportIndex && writeReportIndex < exitIndex,
    "no-op repair must update automerge continuation before writing the terminal report and exiting",
  );
});

test("repair source branch writability preflight runs before expensive repair preflights", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const branchPreflightIndex = source.indexOf(
    "const sourceBranchPreflight = preflightRepairSourceBranchWrite(fixArtifact);",
  );
  const checkoutIndex = source.indexOf("ensureTargetCheckout(result.repo, targetDir);");
  const validationIndex = source.indexOf("preflightTargetValidationPlan(");
  const codexPreflightIndex = source.indexOf("const writePreflight = runCodexWritePreflight();");

  assert.notEqual(branchPreflightIndex, -1);
  assert.notEqual(checkoutIndex, -1);
  assert.notEqual(validationIndex, -1);
  assert.notEqual(codexPreflightIndex, -1);
  assert.ok(
    branchPreflightIndex < checkoutIndex &&
      checkoutIndex < validationIndex &&
      validationIndex < codexPreflightIndex,
    "live source-branch writability must be resolved before checkout, validation planning, and Codex write preflight",
  );
});

test("repair branch pushes settle and re-check the exact source head", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const pushStart = source.indexOf("function pushRepairBranchAndUpdateStatus(");
  const pushEnd = source.indexOf("function repairPushSettleSeconds()", pushStart);
  assert.notEqual(pushStart, -1);
  assert.notEqual(pushEnd, -1);
  const push = source.slice(pushStart, pushEnd);

  assert.match(source, /DEFAULT_REPAIR_PUSH_SETTLE_SECONDS = 90/);
  assert.match(source, /CLAWSWEEPER_BRANCH_PUSH_SETTLE_SECONDS/);
  assert.match(push, /sleepMs\(settleSeconds \* 1000\)/);
  assert.ok(
    push.indexOf("sleepMs(settleSeconds * 1000)") <
      push.indexOf("const livePull = fetchPullRequest"),
    "the live head must be fetched after the settle window",
  );
  assert.ok(
    push.indexOf("repairPushSettleBlock") < push.indexOf("runGitNetwork(pushArgs, targetDir)"),
    "the exact-head guard must run before the branch push",
  );

  const settleStart = source.indexOf("function repairPushSettleBlock(");
  const settle = source.slice(settleStart, source.indexOf("\n}\n", settleStart) + 2);
  assert.match(settle, /initialPull\?\.head\?\.sha/);
  assert.match(settle, /livePull\?\.head\?\.sha/);
  assert.match(settle, /liveState !== "open"/);
  assert.match(settle, /requeue_required: true/);
});

test("merged source replacement skip runs before publishing replacement PRs", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const preparedStart = source.indexOf("function openReplacementPrFromPreparedRepairCheckout(");
  const preparedEnd = source.indexOf("function executeReplacementBranch(", preparedStart);
  assert.notEqual(preparedStart, -1);
  assert.notEqual(preparedEnd, -1);
  const preparedReplacement = source.slice(preparedStart, preparedEnd);
  assert.match(
    preparedReplacement,
    /mergedReplacementSourcePr\(\{ fixArtifact, sourcePr, targetDir \}\)/,
  );
  assert.match(preparedReplacement, /skipMergedSourceReplacementWithoutDiff\(\{/);

  const preparedSkipIndex = preparedReplacement.indexOf("skipMergedSourceReplacementWithoutDiff({");
  const preparedPushIndex = preparedReplacement.indexOf(
    "pushRecoverableBranch({ targetDir, branch });",
  );
  const preparedCreateIndex = preparedReplacement.indexOf('"pr",\n        "create"');
  assert.notEqual(preparedSkipIndex, -1);
  assert.notEqual(preparedPushIndex, -1);
  assert.notEqual(preparedCreateIndex, -1);
  assert.ok(
    preparedSkipIndex < preparedPushIndex && preparedPushIndex < preparedCreateIndex,
    "merged-source no-diff replacement skip must run before branch push and PR creation",
  );

  const helperStart = source.indexOf("function skipMergedSourceReplacementWithoutDiff(");
  const helperEnd = source.indexOf("function labelReplacementPullRequest(", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /if \(!mergedSource\) return null;/);
  assert.match(helper, /if \(branchHasBaseDiff\(\{ targetDir, baseBranch \}\)\) return null;/);
  assert.match(
    helper,
    /reason: "source PR already merged and replacement branch has no changes versus base"/,
  );
});

test("terminal Codex failures do not request repair requeue", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const helperStart = source.indexOf("function isRetryableCodexFailure(");
  const helperEnd = source.indexOf("function isBlockedFixError(", helperStart);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  const terminalGuardIndex = helper.indexOf(
    "if (messages.some((value) => isTerminalCodexErrorMessage(value))) return false;",
  );
  const broadFallbackIndex = helper.indexOf("/Codex .*(?:timed out|failed|exited)");

  assert.notEqual(terminalGuardIndex, -1);
  assert.notEqual(broadFallbackIndex, -1);
  assert.ok(
    terminalGuardIndex < broadFallbackIndex,
    "terminal model-access failures must be rejected before the broad Codex failure fallback",
  );
});

test("repair Codex heartbeat wrapper uses bounded process capture", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const helperStart = source.indexOf("function spawnCodexSyncWithHeartbeat(");
  const helperEnd = source.indexOf("function startCodexHeartbeat(", helperStart);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /return runCodexProcess\(\{/);
  assert.match(helper, /\{ stdoutPath: options\.stdoutPath \}/);
  assert.match(helper, /\{ stderrPath: options\.stderrPath \}/);
  assert.doesNotMatch(helper, /spawnSync\("codex"/);
  assert.doesNotMatch(source, /CLAWSWEEPER_CODEX_STDIO_MAX_BUFFER_MB/);
  assert.doesNotMatch(source, /writeFileSync\([^)]*codexResult\.stdout/);
});

test("issue implementation rechecks opt-out labels immediately before branch pushes", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"),
    "utf8",
  );
  const pushStart = source.indexOf("function pushRecoverableBranch(");
  const pushEnd = source.indexOf("function fetchRemoteRecoverableBranch(", pushStart);
  const helperStart = source.indexOf("function assertIssueImplementationNotPaused(");
  const helperEnd = source.indexOf("function fetchRemoteRecoverableBranch(", helperStart);

  assert.notEqual(pushStart, -1);
  assert.notEqual(pushEnd, -1);
  assert.match(source.slice(pushStart, pushEnd), /assertIssueImplementationNotPaused\(\)/);
  assert.notEqual(helperStart, -1);
  assert.match(source.slice(helperStart, helperEnd), /repairPauseLabel\(issue\.labels\)/);
  assert.match(source.slice(helperStart, helperEnd), /refusing to push or open a PR/);
});

test("repair executor can skip internal Codex review after validation", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"),
    "utf8",
  );

  assert.match(
    source,
    /Math\.max\(0, Number\(process\.env\.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS \?\? 4\)\)/,
  );
  assert.match(source, /if \(maxReviewAttempts === 0\) \{/);
  assert.match(source, /status: "validation_only"/);
  assert.match(
    source,
    /Internal Codex \/review skipped because CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS=0\./,
  );
  assert.match(source, /codexReviewSkipped \? "skipped"/);
});

test("ZeroHrs issue implementation restores protected Android proof harness before commits", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"),
    "utf8",
  );
  const checkpointStart = source.indexOf("function commitCheckpointIfNeeded(");
  const checkpointEnd = source.indexOf("function committableGitStatus(", checkpointStart);
  const unstageStart = source.indexOf("function unstageProofArtifactPaths(");
  const unstageEnd = source.indexOf("function committableGitStatus(", unstageStart);
  const restoreStart = source.indexOf("function restoreZeroHrsIssueProofHarness(");
  const restoreEnd = source.indexOf("function isZeroHrsIssueImplementation(", restoreStart);
  const sourceStart = source.indexOf("function zeroHrsProofHarnessRestoreSource(");
  const proofRequirementStart = source.indexOf("function zeroHrsIssueProofRequirement(");
  const proofSatisfiedStart = source.indexOf('if (proofRequirement.status !== "satisfied")');
  const producedChangesStart = source.indexOf("const hasWorkingTreeChanges", proofSatisfiedStart);
  const copyStart = source.indexOf("function copyExecutorAndroidProofArtifacts(");

  assert.notEqual(checkpointStart, -1);
  assert.notEqual(checkpointEnd, -1);
  assert.notEqual(unstageStart, -1);
  assert.notEqual(unstageEnd, -1);
  assert.notEqual(restoreStart, -1);
  assert.notEqual(restoreEnd, -1);
  assert.notEqual(sourceStart, -1);
  assert.notEqual(proofRequirementStart, -1);
  assert.notEqual(proofSatisfiedStart, -1);
  assert.notEqual(producedChangesStart, -1);
  assert.notEqual(copyStart, -1);

  const checkpoint = source.slice(checkpointStart, checkpointEnd);
  const unstage = source.slice(unstageStart, unstageEnd);
  const restore = source.slice(restoreStart, restoreEnd);
  const sourceHelper = source.slice(sourceStart, source.indexOf("function pushRecoverableBranch("));
  const proofSatisfied = source.slice(proofSatisfiedStart, producedChangesStart);
  const copyHelper = source.slice(
    copyStart,
    source.indexOf("function listRelativeFiles(", copyStart),
  );
  const proofPathStart = source.indexOf("const PROOF_ARTIFACT_GIT_PATHS = [");
  const proofPathEnd = source.indexOf("];", proofPathStart);
  const proofPaths = source.slice(proofPathStart, proofPathEnd);
  const proofExcludeStart = source.indexOf("const PROOF_ARTIFACT_GIT_EXCLUDE_PATHS = [");
  const proofExcludeEnd = source.indexOf("];", proofExcludeStart);
  const proofExcludes = source.slice(proofExcludeStart, proofExcludeEnd);
  const changedStart = restore.indexOf(
    'const changed = run("git", ["status", "--porcelain", "--", ...tracked]',
  );
  const changedEnd = restore.indexOf("const baseDiff", changedStart);
  const changedBlock = restore.slice(changedStart, changedEnd);

  assert.match(source, /ZEROHRS_ANDROID_PROOF_HARNESS_FILES = \[/);
  assert.match(source, /EXECUTOR_ANDROID_REQUIRED_PROOF_FILES = \[/);
  assert.match(source, /zeroHrsIssueProofRequirement\(\{/);
  assert.match(source, /do not edit or bootstrap protected proof infrastructure/);
  assert.match(source, /manifest\.status !== "completed"/);
  assert.match(source, /firstManifestString\(manifest/);
  assert.match(
    source,
    /ZeroHrs Android proof manifest is missing the issue-specific reproduction route/,
  );
  assert.match(
    source,
    /ZeroHrs Android proof manifest is missing before\/after refs or branch names/,
  );
  assert.match(source, /ZeroHrs Android proof manifest before\/after refs must differ/);
  assert.match(source, /launcher_screen_detected as false/);
  assert.match(source, /captures\?\.before\?\.loading_screenshot/);
  assert.match(source, /captures\.before\.issue_reproduced/);
  assert.match(source, /captures\.before.*issue_evidence/s);
  assert.match(source, /captures\.after\.issue_resolved/);
  assert.match(source, /captures\.after.*fix_evidence/s);
  assert.match(proofSatisfied, /copyExecutorAndroidProofArtifacts\(resultPath\)/);
  assert.match(
    proofSatisfied,
    /ZeroHrs Android proof passed validation but could not be collected/,
  );
  assert.match(proofSatisfied, /collected ZeroHrs Android proof artifacts/);
  assert.match(copyHelper, /EXECUTOR_ANDROID_PROOF_RUN_DIR/);
  assert.match(
    copyHelper,
    /fs\.cpSync\(sourceDir, destination, \{ recursive: true, force: true \}\)/,
  );
  assert.match(source, /ZEROHRS_FORBIDDEN_PROOF_ROUTE_PATH_PATTERNS = \[/);
  assert.match(source, /ZEROHRS_FORBIDDEN_PROOF_ROUTE_TEXT_PATTERNS = \[/);
  assert.match(source, /zeroHrsProofRoute/);
  assert.match(source, /EXPO_PUBLIC_\[A-Z0-9_\]\*PROOF/);
  assert.match(source, /Constants\\\.expoConfig/);
  assert.match(source, /assertNoZeroHrsProofRouteProductDiff\(\{/);
  assert.match(source, /zeroHrsForbiddenProofRouteDiff\(\{/);
  assert.match(source, /changedDiffLinesOnly\(diffText\)/);
  assert.match(source, /function changedDiffLinesOnly\(diffText: string\)/);
  assert.match(source, /line\.startsWith\("\+"\) && !line\.startsWith\("\+\+\+"\)/);
  assert.match(source, /line\.startsWith\("-"\) && !line\.startsWith\("---"\)/);
  assert.doesNotMatch(
    source,
    /fs\.existsSync\(path\.join\(targetDir, file\)\) &&\s*ZEROHRS_FORBIDDEN_PROOF_ROUTE_PATH_PATTERNS/s,
  );
  assert.match(source, /pattern\.test\(changedDiffText\)/);
  assert.match(source, /ZeroHrs Android proof must use manual app navigation/);
  assert.match(source, /committed proof-route product code/);
  assert.match(source, /Remove proof-only navigation, env, Constants\.expoConfig/);
  assert.match(source, /scripts\/crabbox\/android-proof\.sh/);
  assert.match(source, /scripts\/crabbox\/bootstrap-hetzner-android-runner\.sh/);
  assert.match(source, /scripts\/crabbox\/run-android-proof\.sh/);
  assert.match(source, /docs\/crabbox-hetzner-feedback\.md/);
  assert.match(proofPaths, /EXECUTOR_ANDROID_PROOF_SOURCE_DIR/);
  assert.match(proofPaths, /LEGACY_ANDROID_PROOF_SOURCE_DIR/);
  assert.match(proofExcludes, /EXECUTOR_ANDROID_PROOF_SOURCE_DIR/);
  assert.match(proofExcludes, /LEGACY_ANDROID_PROOF_SOURCE_DIR/);
  assert.doesNotMatch(proofExcludes, /ZEROHRS_ANDROID_PROOF_HARNESS_FILES/);
  assert.doesNotMatch(proofExcludes, /scripts\/crabbox/);
  assert.doesNotMatch(proofExcludes, /docs\/crabbox-hetzner-feedback/);
  assert.ok(
    checkpoint.indexOf("restoreZeroHrsIssueProofHarness({ targetDir });") <
      checkpoint.indexOf("assertNoZeroHrsProofRouteProductDiff({ targetDir });") &&
      checkpoint.indexOf("assertNoZeroHrsProofRouteProductDiff({ targetDir });") <
        checkpoint.indexOf('run("git", ["add"'),
    "protected proof harness files must be restored and proof-route product diffs blocked before staging",
  );
  assert.match(checkpoint, /run\("git", \["add", "--all", "--", "\."\]/);
  assert.doesNotMatch(
    checkpoint,
    /"add", "--all", "--", "\.", \.\.\.PROOF_ARTIFACT_GIT_EXCLUDE_PATHS/,
  );
  assert.ok(
    checkpoint.indexOf('run("git", ["add"') <
      checkpoint.indexOf("unstageProofArtifactPaths({ targetDir });"),
    "proof artifacts must be unstaged after normal git add so ignored proof dirs do not crash git add",
  );
  assert.match(unstage, /"diff", "--cached", "--name-only", "--", \.\.\.PROOF_ARTIFACT_GIT_PATHS/);
  assert.match(unstage, /"reset", "-q", "HEAD", "--", \.\.\.PROOF_ARTIFACT_GIT_PATHS/);
  assert.match(restore, /isZeroHrsIssueImplementation\(\)/);
  assert.match(restore, /zeroHrsProofHarnessRestoreSource\(targetDir\)/);
  assert.match(restore, /git", \["diff", "--name-only", restoreSource/);
  assert.match(restore, /git", \["restore", "--source", restoreSource/);
  assert.match(restore, /restored ZeroHrs proof harness files before checkpoint/);
  assert.match(changedBlock, /\.filter\(\(line\) => line\.trim\(\)\)/);
  assert.match(changedBlock, /\.map\(\(line\) => line\.slice\(3\)\.trim\(\)\)/);
  assert.doesNotMatch(changedBlock, /\.map\(\(line\) => line\.trim\(\)\)/);
  assert.match(sourceHelper, /origin\/\$\{baseBranch\}/);
  assert.match(sourceHelper, /return check\.status === 0 \? candidate : "HEAD"/);
});
