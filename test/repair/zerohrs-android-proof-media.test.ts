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
  const recoverIndex = workflow.indexOf("name: Recover remote ZeroHrs Android proof media");
  const uploadIndex = workflow.indexOf("name: Upload ZeroHrs Android proof media");
  const postFlightIndex = workflow.indexOf("name: Post-flight finalize fix PRs");

  assert.notEqual(executeIndex, -1);
  assert.notEqual(proofIndex, -1);
  assert.notEqual(recoverIndex, -1);
  assert.notEqual(uploadIndex, -1);
  assert.notEqual(postFlightIndex, -1);
  assert.ok(
    executeIndex < proofIndex &&
      proofIndex < recoverIndex &&
      recoverIndex < uploadIndex &&
      uploadIndex < postFlightIndex,
    "proof media must be generated and uploaded before post-flight can mark the PR ready",
  );
  assert.match(
    workflow,
    /pnpm run repair:zerohrs-android-proof -- "\$\{\{ inputs\.job \}\}" --latest/,
  );
  assert.match(
    workflow,
    /ZEROHRS_GITHUB_USER_ATTACHMENT_COOKIE: \$\{\{ secrets\.ZEROHRS_GITHUB_USER_ATTACHMENT_COOKIE \}\}/,
  );
  assert.match(
    workflow,
    /find "\$work_root" -path '\*\/zerohrs-app\/reports\/clawsweeper\/android-proof\/command\.log'/,
  );
  assert.match(
    workflow,
    /remote-zerohrs-android-proof-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/,
  );
  assert.match(workflow, /path: \.clawsweeper-repair\/runs\/\*\*\/zerohrs-android-proof\/\*\*/);
});

test("ZeroHrs issue implementation planning captures and publishes current-state Android proof", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const resolveIndex = workflow.indexOf("name: Resolve ZeroHrs Android planning proof target");
  const checkoutIndex = workflow.indexOf(
    "name: Checkout ZeroHrs target for Android planning proof",
  );
  const runProofIndex = workflow.indexOf("name: Run ZeroHrs Android issue planning evidence");
  const publishProofIndex = workflow.indexOf(
    "name: Publish ZeroHrs Android issue planning proof media",
  );
  const uploadProofIndex = workflow.indexOf(
    "name: Upload ZeroHrs Android issue planning proof media",
  );
  const workerIndex = workflow.indexOf("name: Run worker");

  assert.notEqual(resolveIndex, -1);
  assert.notEqual(checkoutIndex, -1);
  assert.notEqual(runProofIndex, -1);
  assert.notEqual(publishProofIndex, -1);
  assert.notEqual(uploadProofIndex, -1);
  assert.notEqual(workerIndex, -1);
  assert.ok(
    resolveIndex < checkoutIndex &&
      checkoutIndex < runProofIndex &&
      runProofIndex < publishProofIndex &&
      publishProofIndex < uploadProofIndex &&
      uploadProofIndex < workerIndex,
    "current-state Android proof must be captured and published before the planner runs",
  );
  assert.match(workflow, /source_issue_number/);
  assert.match(
    workflow,
    /repository: \$\{\{ steps\.zerohrs_review_proof_target\.outputs\.target_repo \}\}/,
  );
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /reports\/crabbox-android\/before-loading\.png/);
  assert.match(workflow, /reports\/crabbox-android\/before\.mp4/);
  assert.match(workflow, /annotate_planning_proof_manifest/);
  assert.match(workflow, /manifest\.item_number = itemNumber/);
  assert.match(workflow, /source_issue_url/);
  assert.match(workflow, /planning_review_current_state/);
  assert.match(workflow, /Planning\/review evidence is current-state reproduction evidence only/);
  assert.match(workflow, /manually navigating the real app UI/);
  assert.match(workflow, /issue-specific route or visible reported state/);
  assert.match(workflow, /product proof routes/);
  assert.match(workflow, /proof-route env flags/);
  assert.match(workflow, /tests whose only purpose is proof navigation/);
  assert.match(workflow, /crabbox run[\s\S]*--provider ssh/);
  assert.match(workflow, /bash scripts\/crabbox\/android-proof\.sh/);
  assert.match(workflow, /repair:zerohrs-android-review-proof/);
  assert.match(
    workflow,
    /zerohrs-android-planning-proof-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(workflow, /ZEROHRS_ANDROID_PROOF_DRY_RUN=1/);
});

test("ZeroHrs Android review proof publisher plans current-state issue media", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-review-proof-media-"));
  const proofDir = path.join(tmp, "zerohrs-android-proof-1");
  const reportPath = path.join(tmp, "review-proof-report.json");
  fs.mkdirSync(proofDir, { recursive: true });
  for (const name of [
    "command.log",
    "emulator.log",
    "app.log",
    "before-loading.png",
    "before.mp4",
    "before.png",
  ]) {
    fs.writeFileSync(path.join(proofDir, name), `${name}\n`);
  }
  fs.writeFileSync(
    path.join(proofDir, "proof-manifest.json"),
    JSON.stringify(
      {
        status: "completed",
        item_number: 274,
        reproduction_route: "Billing gate > Compare Plans",
        captures: {
          before: {
            route: "Billing gate > Compare Plans",
            launcher_screen_detected: false,
            loading_screenshot: "before-loading.png",
            screenshot: "before.png",
            recording: "before.mp4",
          },
        },
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(
      process.execPath,
      [
        "dist/repair/zerohrs-android-review-proof-media.js",
        "--proof-root",
        tmp,
        "--report",
        reportPath,
        "--dry-run",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GITHUB_RUN_ID: "28504191806",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_SHA: "0b05eb93a12b9f3c15985766a6e7ff09571d24cb",
        },
        stdio: "pipe",
      },
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "planned");
    assert.equal(report.actions[0].action, "zerohrs_android_review_proof");
    assert.equal(report.actions[0].status, "planned");
    assert.equal(report.actions[0].issue, "#274");
    assert.match(
      report.actions[0].asset_prefix,
      /^proof-media\/issue-274\/review-run-28504191806-attempt-2-0b05eb93a12b$/,
    );
    assert.deepEqual(
      report.actions[0].files.map((file: { name: string }) => file.name),
      [
        "proof-manifest.json",
        "command.log",
        "emulator.log",
        "app.log",
        "before-loading.png",
        "before.mp4",
        "before.png",
      ],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ZeroHrs Android proof publisher rejects generic before-after media without issue assertions", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-media-invalid-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "zerohrs-android-proof-report.json");
  const proofDir = path.join(runDir, "zerohrs-android-proof", "executor");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(proofDir, { recursive: true });
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
  for (const name of [
    "command.log",
    "emulator.log",
    "app.log",
    "before-loading.png",
    "after-loading.png",
    "before.mp4",
    "after.mp4",
    "before.png",
    "after.png",
  ]) {
    fs.writeFileSync(path.join(proofDir, name), `${name}\n`);
  }
  fs.writeFileSync(
    path.join(proofDir, "proof-manifest.json"),
    JSON.stringify(
      {
        status: "completed",
        reproduction_route: "Billing gate > Compare Plans",
        before_ref: "base-main-sha",
        after_ref: "66525b903309",
        captures: {
          before: {
            route: "Billing gate > Compare Plans",
            ref: "base-main-sha",
            launcher_screen_detected: false,
            loading_screenshot: "before-loading.png",
            screenshot: "before.png",
            recording: "before.mp4",
          },
          after: {
            route: "Billing gate > Compare Plans",
            ref: "66525b903309",
            launcher_screen_detected: false,
            loading_screenshot: "after-loading.png",
            screenshot: "after.png",
            recording: "after.mp4",
          },
        },
      },
      null,
      2,
    ),
  );

  try {
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["dist/repair/zerohrs-android-proof-media.js", jobPath, resultPath],
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
      ),
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "failed");
    assert.match(String(report.reason), /captures\.before\.issue_reproduced/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ZeroHrs Android proof publisher rejects completed media without prose evidence", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-media-legacy-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "zerohrs-android-proof-report.json");
  const proofDir = path.join(runDir, "zerohrs-android-proof", "executor");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(proofDir, { recursive: true });
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
  for (const name of [
    "command.log",
    "emulator.log",
    "app.log",
    "before-loading.png",
    "after-loading.png",
    "before.mp4",
    "after.mp4",
    "before.png",
    "after.png",
  ]) {
    fs.writeFileSync(path.join(proofDir, name), `${name}\n`);
  }
  fs.writeFileSync(
    path.join(proofDir, "proof-manifest.json"),
    JSON.stringify(
      {
        status: "completed",
        reproduction_route: "Billing gate > Compare Plans",
        before_ref: "base-main-sha",
        after_ref: "66525b903309",
        captures: {
          before: {
            route: "Billing gate > Compare Plans",
            ref: "base-main-sha",
            launcher_screen_detected: false,
            loading_screenshot: "before-loading.png",
            screenshot: "before.png",
            recording: "before.mp4",
            issue_reproduced: true,
          },
          after: {
            route: "Billing gate > Compare Plans",
            ref: "66525b903309",
            launcher_screen_detected: false,
            loading_screenshot: "after-loading.png",
            screenshot: "after.png",
            recording: "after.mp4",
            issue_resolved: true,
          },
        },
      },
      null,
      2,
    ),
  );

  try {
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["dist/repair/zerohrs-android-proof-media.js", jobPath, resultPath],
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
      ),
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "failed");
    assert.match(String(report.reason), /captures\.before\.issue_evidence/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ZeroHrs Android proof publisher rejects after media captured from non-PR head", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-media-stale-after-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "zerohrs-android-proof-report.json");
  const proofDir = path.join(runDir, "zerohrs-android-proof", "executor");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(proofDir, { recursive: true });
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
  for (const name of [
    "command.log",
    "emulator.log",
    "app.log",
    "before-loading.png",
    "after-loading.png",
    "before.mp4",
    "after.mp4",
    "before.png",
    "after.png",
  ]) {
    fs.writeFileSync(path.join(proofDir, name), `${name}\n`);
  }
  fs.writeFileSync(
    path.join(proofDir, "proof-manifest.json"),
    JSON.stringify(
      {
        status: "completed",
        reproduction_route: "Billing gate > Compare Plans",
        before_ref: "027206aa53bc",
        after_ref: "3d557e46fb51",
        captures: {
          before: {
            route: "Billing gate > Compare Plans",
            ref: "027206aa53bc",
            launcher_screen_detected: false,
            loading_screenshot: "before-loading.png",
            screenshot: "before.png",
            recording: "before.mp4",
            issue_reproduced: true,
            issue_evidence: "Plans comparison shows Ess before the fix.",
          },
          after: {
            route: "Billing gate > Compare Plans",
            ref: "3d557e46fb51",
            launcher_screen_detected: false,
            loading_screenshot: "after-loading.png",
            screenshot: "after.png",
            recording: "after.mp4",
            issue_resolved: true,
            fix_evidence: "Plans comparison should show Basic after the fix.",
          },
        },
      },
      null,
      2,
    ),
  );

  try {
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["dist/repair/zerohrs-android-proof-media.js", jobPath, resultPath],
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
      ),
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "failed");
    assert.match(String(report.reason), /after_ref 3d557e46fb51 does not match PR head/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ZeroHrs Android proof publisher collects executor-owned artifacts", () => {
  const source = fs.readFileSync("src/repair/zerohrs-android-proof-media.ts", "utf8");

  assert.match(
    source,
    /const EXECUTOR_PROOF_DIR = path\.join\("zerohrs-android-proof", "executor"\)/,
  );
  assert.match(source, /const executorProofDir = path\.join\(runDir, EXECUTOR_PROOF_DIR\)/);
  assert.match(
    source,
    /fs\.cpSync\(executorProofDir, proofDir, \{ recursive: true, force: true \}\)/,
  );
  assert.match(
    source,
    /executor did not produce Android proof media under reports\/clawsweeper\/android-proof/,
  );
  assert.doesNotMatch(source, /run\("crabbox"/);
  assert.doesNotMatch(source, /scripts\/crabbox\/android-proof\.sh/);
  assert.doesNotMatch(source, /function clonePullRequest\(/);
  assert.doesNotMatch(source, /function composeBeforeAfterProof\(/);
});

test("ZeroHrs Android proof publisher blocks when executor proof is missing", () => {
  const source = fs.readFileSync("src/repair/zerohrs-android-proof-media.ts", "utf8");
  const copyStart = source.indexOf('const proofRoot = path.join(runDir, "zerohrs-android-proof")');
  const publishStart = source.indexOf("const proofFiles = validateProofFiles(", copyStart);
  assert.notEqual(copyStart, -1);
  assert.notEqual(publishStart, -1);
  const collectionBlock = source.slice(copyStart, publishStart);

  assert.match(collectionBlock, /if \(!fs\.existsSync\(executorProofDir\)\)/);
  assert.match(collectionBlock, /status: "blocked"/);
  assert.match(collectionBlock, /expected_executor_path: "reports\/clawsweeper\/android-proof"/);
  assert.match(collectionBlock, /fs\.rmSync\(proofDir, \{ recursive: true, force: true \}\)/);
  assert.match(collectionBlock, /fs\.mkdirSync\(proofDir, \{ recursive: true \}\)/);
});

test("ZeroHrs Android proof comments prefer GitHub attachments with private-repo-safe fallbacks", () => {
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
  assert.match(source, /GITHUB_ATTACHMENT_IMAGE_LIMIT_BYTES = 10_000_000/);
  assert.match(source, /GITHUB_ATTACHMENT_VIDEO_LIMIT_BYTES = 100_000_000/);
  assert.match(helper, /ZEROHRS_GITHUB_USER_ATTACHMENT_COOKIE/);
  assert.match(helper, /upload\/policies\/assets/);
  assert.match(helper, /file exceeds GitHub comment attachment limit/);
  assert.match(helper, /Fallback file link:/);
  assert.match(helper, /renderGitHubAttachmentMarkdown/);
  assert.match(helper, /!\[\$\{label\}\]\(\$\{url\}\)/);
  assert.match(helper, /Before loading screenshot", "before-loading\.png"/);
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
