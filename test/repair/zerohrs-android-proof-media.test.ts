import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("ZeroHrs Android proof media dry-run plans PR media publication", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-media-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "zerohrs-android-proof-report.json");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'pr' && args[1] === 'view' && args[2] === '272') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 272,",
      "    url: 'https://github.com/ZeroHrs-Org/zerohrs-app/pull/272',",
      "    title: 'Add Android proof media',",
      "    headRefName: 'clawsweeper/issue-zerohrs-org-zerohrs-app-271',",
      "    headRefOid: '66525b903309a706545d7c074150cf73728845f6',",
      "    baseRefName: 'main',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(jobPath, zeroHrsIssueImplementationJob());
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "ZeroHrs-Org/zerohrs-app",
        cluster_id: "issue-zerohrs-org-zerohrs-app-271",
        mode: "autonomous",
        actions: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, "fix-execution-report.json"),
    JSON.stringify(
      {
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/ZeroHrs-Org/zerohrs-app/pull/272",
            branch: "clawsweeper/issue-zerohrs-org-zerohrs-app-271",
          },
        ],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(
      process.execPath,
      ["dist/repair/zerohrs-android-proof-media.js", jobPath, resultPath, "--dry-run"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CLAWSWEEPER_ALLOWED_OWNER: "ZeroHrs-Org",
          GITHUB_RUN_ID: "28504191806",
          GITHUB_RUN_ATTEMPT: "1",
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: "pipe",
      },
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "planned");
    assert.equal(report.actions[0].action, "zerohrs_android_proof");
    assert.equal(report.actions[0].status, "planned");
    assert.equal(report.actions[0].pr, "#272");
    assert.equal(report.actions[0].asset_branch, "zerohrs-clawsweeper-proof-assets");
    assert.match(
      report.actions[0].asset_prefix,
      /^proof-media\/pr-272\/run-28504191806-attempt-1-66525b903309$/,
    );
    assert.deepEqual(
      report.actions[0].files.map((file: { name: string }) => file.name),
      [
        "proof-manifest.json",
        "command.log",
        "emulator.log",
        "app.log",
        "before-loading.png",
        "after-loading.png",
        "before.mp4",
        "after.mp4",
        "before.png",
        "after.png",
      ],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ZeroHrs Android proof workflow runs before issue implementation post-flight", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const executeIndex = workflow.indexOf("name: Execute credited fix artifact");
  const proofIndex = workflow.indexOf("name: Publish ZeroHrs Android proof media");
  const uploadIndex = workflow.indexOf("name: Upload ZeroHrs Android proof media");
  const postFlightIndex = workflow.indexOf("name: Post-flight finalize fix PRs");

  assert.notEqual(executeIndex, -1);
  assert.notEqual(proofIndex, -1);
  assert.notEqual(uploadIndex, -1);
  assert.notEqual(postFlightIndex, -1);
  assert.ok(
    executeIndex < proofIndex && proofIndex < uploadIndex && uploadIndex < postFlightIndex,
    "proof media must be generated and uploaded before post-flight can mark the PR ready",
  );
  assert.match(
    workflow,
    /pnpm run repair:zerohrs-android-proof -- "\$\{\{ inputs\.job \}\}" --latest/,
  );
  assert.match(workflow, /path: \.clawsweeper-repair\/runs\/\*\*\/zerohrs-android-proof\/\*\*/);
});

test("ZeroHrs Android proof publisher composes before from main and after from PR", () => {
  const source = fs.readFileSync("src/repair/zerohrs-android-proof-media.ts", "utf8");
  const composeIndex = source.indexOf("function composeBeforeAfterProof(");
  assert.notEqual(composeIndex, -1);
  const compose = source.slice(
    composeIndex,
    source.indexOf("function copyProofFile(", composeIndex),
  );

  assert.match(source, /const baseTargetDir = cloneBaseReference\(baseRefName, proofRoot\)/);
  assert.match(source, /const fixedTargetDir = clonePullRequest\(parsed\.number, proofRoot\)/);
  assert.match(compose, /copyProofFile\(beforeDir, outputDir, "before-loading\.png"\)/);
  assert.match(compose, /copyProofFile\(beforeDir, outputDir, "before\.mp4"\)/);
  assert.match(compose, /copyProofFile\(afterDir, outputDir, "after-loading\.png"\)/);
  assert.match(compose, /copyProofFile\(afterDir, outputDir, "after\.mp4"\)/);
  assert.match(compose, /source: "main"/);
  assert.match(compose, /source: "fix_pr"/);
});

test("ZeroHrs Android proof publisher runs Crabbox with terminal success stop policy", () => {
  const source = fs.readFileSync("src/repair/zerohrs-android-proof-media.ts", "utf8");
  const argsStart = source.indexOf("function zeroHrsAndroidProofRunArgs(");
  const argsEnd = source.indexOf("function zeroHrsAndroidProofEnv(", argsStart);
  assert.notEqual(argsStart, -1);
  assert.notEqual(argsEnd, -1);
  const helper = source.slice(argsStart, argsEnd);

  assert.match(source, /run\("crabbox", zeroHrsAndroidProofRunArgs\(\)/);
  assert.match(helper, /"--artifact-glob"/);
  assert.match(helper, /REQUIRED_REMOTE_PROOF_FILES/);
  assert.match(helper, /"--stop-after", "success"/);
  assert.doesNotMatch(helper, /"--stop-after", "never"/);
});

test("ZeroHrs Android proof publisher extracts Crabbox collected artifacts", () => {
  const source = fs.readFileSync("src/repair/zerohrs-android-proof-media.ts", "utf8");

  assert.match(source, /function copySourceProofRun\(/);
  assert.match(source, /function findLatestCrabboxArtifactTarball\(/);
  assert.match(source, /\.crabbox", "runs"/);
  assert.match(source, /"-artifacts\.tgz"/);
  assert.match(source, /"tar", \["-xzf", artifactPath/);
  assert.match(source, /"reports\/crabbox-android"/);
});

test("ZeroHrs Android proof comments use private-repo-safe file links", () => {
  const source = fs.readFileSync("src/repair/zerohrs-android-proof-media.ts", "utf8");
  const urlsStart = source.indexOf("function buildProofAssetUrls(");
  const urlsEnd = source.indexOf("function publishProofComment(", urlsStart);
  const commentEnd = source.indexOf("function findExistingProofComment(", urlsEnd);
  assert.notEqual(urlsStart, -1);
  assert.notEqual(urlsEnd, -1);
  assert.notEqual(commentEnd, -1);
  const helper = source.slice(urlsStart, commentEnd);

  assert.match(helper, /github\.com\/\$\{ZEROHRS_REPO\}\/blob/);
  assert.doesNotMatch(helper, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(helper, /!\[Before loading\]/);
  assert.match(helper, /Before loading screenshot:/);
});

function zeroHrsIssueImplementationJob() {
  return [
    "---",
    "repo: ZeroHrs-Org/zerohrs-app",
    "cluster_id: issue-zerohrs-org-zerohrs-app-271",
    "mode: autonomous",
    "allowed_actions:",
    "  - comment",
    "  - label",
    "  - fix",
    "  - raise_pr",
    "blocked_actions:",
    "  - close",
    "  - merge",
    "canonical:",
    "  - '#271'",
    "candidates:",
    "  - '#271'",
    "cluster_refs:",
    "  - '#271'",
    "allow_fix_pr: true",
    "allow_merge: false",
    "security_policy: central_security_only",
    "security_sensitive: false",
    "target_branch: clawsweeper/issue-zerohrs-org-zerohrs-app-271",
    "source: issue_implementation",
    "---",
    "Issue implementation job.",
    "",
  ].join("\n");
}
