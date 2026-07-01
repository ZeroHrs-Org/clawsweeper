#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand as run } from "./command-runner.js";
import { ghJsonWithRetry as ghJson, ghTextWithRetry as ghText } from "./github-cli.js";
import { assertAllowedOwner, parseArgs, parseJob, repoRoot, validateJob } from "./lib.js";
import { parsePullRequestUrl } from "./github-ref.js";

const ZEROHRS_REPO = "ZeroHrs-Org/zerohrs-app";
const PROOF_ASSET_BRANCH = "zerohrs-clawsweeper-proof-assets";
const PROOF_MARKER_PREFIX = "<!-- clawsweeper-zerohrs-android-proof";
let gitAskpassPath: string | null = null;
const REQUIRED_PROOF_FILES = [
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
];
const REQUIRED_REMOTE_PROOF_FILES = REQUIRED_PROOF_FILES.map(
  (name) => `reports/crabbox-android/${name}`,
);
const MEDIA_FILES = [
  "proof-manifest.json",
  "before-loading.png",
  "after-loading.png",
  "before.mp4",
  "after.mp4",
  "before.png",
  "after.png",
];

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const resultPathArg = args._[1];
const latest = Boolean(args.latest);
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_ZEROHRS_PROOF_DRY_RUN === "1");
const proofTimeoutMs = Number(
  process.env.CLAWSWEEPER_ZEROHRS_ANDROID_PROOF_TIMEOUT_MS ?? 65 * 60 * 1000,
);

if (!jobPath) {
  console.error(
    "usage: node dist/repair/zerohrs-android-proof-media.js <job.md> [result.json] [--latest] [--dry-run]",
  );
  process.exit(2);
}
if (!resultPathArg && !latest) {
  console.error("result path is required unless --latest is set");
  process.exit(2);
}

const job = parseJob(jobPath);
const jobErrors = validateJob(job);
if (jobErrors.length > 0) {
  console.error(jobErrors.join("\n"));
  process.exit(1);
}

assertAllowedOwner(job.frontmatter.repo, process.env.CLAWSWEEPER_ALLOWED_OWNER);

const resultPath = resultPathArg ? path.resolve(resultPathArg) : findLatestResultPath();
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
if (result.repo !== job.frontmatter.repo) {
  throw new Error(`result repo ${result.repo} does not match job repo ${job.frontmatter.repo}`);
}
if (result.cluster_id !== job.frontmatter.cluster_id) {
  throw new Error(
    `result cluster ${result.cluster_id} does not match job cluster ${job.frontmatter.cluster_id}`,
  );
}

const runDir = path.dirname(resultPath);
const reportPath =
  typeof args.report === "string"
    ? path.resolve(args.report)
    : path.join(runDir, "zerohrs-android-proof-report.json");
const report: LooseRecord = {
  repo: result.repo,
  cluster_id: result.cluster_id,
  dry_run: dryRun,
  result_path: path.relative(repoRoot(), resultPath),
  proof_at: new Date().toISOString(),
  actions: [],
};

try {
  const action = maybeRunZeroHrsProof();
  report.actions.push(action);
  report.status = action.status;
  if (action.reason) report.reason = action.reason;
  writeReport();
  if (action.status === "failed" || action.status === "blocked") process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.reason = String(error?.message ?? error);
  report.actions.push({
    action: "zerohrs_android_proof",
    status: "failed",
    reason: report.reason,
  });
  writeReport();
  throw error;
}

function maybeRunZeroHrsProof() {
  if (String(result.repo ?? "").toLowerCase() !== ZEROHRS_REPO.toLowerCase()) {
    return {
      action: "zerohrs_android_proof",
      status: "skipped",
      reason: "target repo is not ZeroHrs app",
    };
  }
  if (job.frontmatter.source !== "issue_implementation") {
    return {
      action: "zerohrs_android_proof",
      status: "skipped",
      reason: "job is not an issue implementation",
    };
  }

  const fixReport = readSiblingJson("fix-execution-report.json");
  const fixPr = latestFixPullRequest(fixReport);
  if (!fixPr) {
    return {
      action: "zerohrs_android_proof",
      status: "blocked",
      reason: "no generated fix PR was found in fix-execution-report.json",
    };
  }

  const parsed = parsePullRequestUrl(fixPr.pr_url);
  if (!parsed || parsed.repo.toLowerCase() !== ZEROHRS_REPO.toLowerCase()) {
    return {
      action: "zerohrs_android_proof",
      status: "blocked",
      reason: "generated fix PR URL is missing or outside ZeroHrs app",
      pr_url: fixPr.pr_url ?? null,
    };
  }

  const view = fetchPullRequestView(parsed.number);
  if (dryRun) {
    const published = buildProofAssetUrls({
      prNumber: parsed.number,
      headSha: view.headRefOid,
    });
    return {
      action: "zerohrs_android_proof",
      status: "planned",
      pr: `#${parsed.number}`,
      pr_url: view.url ?? fixPr.pr_url,
      head_sha: view.headRefOid ?? null,
      asset_branch: PROOF_ASSET_BRANCH,
      asset_prefix: published.prefix,
      files: REQUIRED_PROOF_FILES.map((name) => ({ name, size: null })),
    };
  }

  const proofRoot = path.join(runDir, "zerohrs-android-proof");
  const proofDir = path.join(proofRoot, `pr-${parsed.number}`);
  const beforeDir = path.join(proofRoot, `pr-${parsed.number}-before-main`);
  const afterDir = path.join(proofRoot, `pr-${parsed.number}-after-fix`);
  fs.rmSync(proofDir, { recursive: true, force: true });
  fs.rmSync(beforeDir, { recursive: true, force: true });
  fs.rmSync(afterDir, { recursive: true, force: true });
  fs.mkdirSync(proofDir, { recursive: true });
  fs.mkdirSync(beforeDir, { recursive: true });
  fs.mkdirSync(afterDir, { recursive: true });

  const baseRefName = String(view.baseRefName ?? "main") || "main";
  const baseTargetDir = cloneBaseReference(baseRefName, proofRoot);
  runProofCommand({ targetDir: baseTargetDir, proofDir: beforeDir });

  const fixedTargetDir = clonePullRequest(parsed.number, proofRoot);
  runProofCommand({ targetDir: fixedTargetDir, proofDir: afterDir });

  composeBeforeAfterProof({
    beforeDir,
    afterDir,
    outputDir: proofDir,
    prNumber: parsed.number,
    beforeRef: baseRefName,
    afterRef: view.headRefName ?? `pull/${parsed.number}`,
    beforeSha: baseHeadSha(baseTargetDir),
    afterSha: view.headRefOid,
  });
  const proofFiles = validateProofFiles(proofDir);
  const published = publishProofAssets({
    proofDir,
    prNumber: parsed.number,
    headSha: view.headRefOid,
    proofFiles,
  });
  const comment = publishProofComment({
    prNumber: parsed.number,
    prUrl: view.url ?? fixPr.pr_url,
    headSha: view.headRefOid,
    published,
  });

  return {
    action: "zerohrs_android_proof",
    status: dryRun ? "planned" : "published",
    pr: `#${parsed.number}`,
    pr_url: view.url ?? fixPr.pr_url,
    head_sha: view.headRefOid ?? null,
    proof_dir: path.relative(repoRoot(), proofDir),
    asset_branch: PROOF_ASSET_BRANCH,
    asset_prefix: published.prefix,
    comment_url: comment.url ?? null,
    files: proofFiles,
  };
}

function latestFixPullRequest(fixReport: LooseRecord) {
  const actions = Array.isArray(fixReport?.actions) ? fixReport.actions : [];
  return [...actions]
    .reverse()
    .find(
      (action: LooseRecord) =>
        ["open_fix_pr", "repair_contributor_branch"].includes(String(action?.action ?? "")) &&
        ["opened", "pushed", "updated"].includes(String(action?.status ?? "")) &&
        typeof action?.pr_url === "string" &&
        action.pr_url.trim(),
    );
}

function fetchPullRequestView(number: number) {
  return ghJson<LooseRecord>([
    "pr",
    "view",
    String(number),
    "--repo",
    ZEROHRS_REPO,
    "--json",
    ["number", "url", "title", "headRefName", "headRefOid", "baseRefName"].join(","),
  ]);
}

function clonePullRequest(number: number, proofRoot: string) {
  const targetDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-target-")),
    "repo",
  );
  cloneZeroHrsRepo(targetDir, ["--filter=blob:none"]);
  run("git", ["fetch", "origin", `pull/${number}/head:zerohrs-proof-pr-${number}`], {
    cwd: targetDir,
    env: gitAuthEnv(),
    timeoutMs: 5 * 60 * 1000,
  });
  run("git", ["checkout", `zerohrs-proof-pr-${number}`], {
    cwd: targetDir,
    timeoutMs: 60_000,
  });
  fs.mkdirSync(proofRoot, { recursive: true });
  return targetDir;
}

function cloneBaseReference(baseRefName: string, proofRoot: string) {
  const targetDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-base-")),
    "repo",
  );
  cloneZeroHrsRepo(targetDir, ["--filter=blob:none"]);
  run("git", ["fetch", "origin", `${baseRefName}:zerohrs-proof-base-${baseRefName}`], {
    cwd: targetDir,
    env: gitAuthEnv(),
    timeoutMs: 5 * 60 * 1000,
  });
  run("git", ["checkout", `zerohrs-proof-base-${baseRefName}`], {
    cwd: targetDir,
    timeoutMs: 60_000,
  });
  fs.mkdirSync(proofRoot, { recursive: true });
  return targetDir;
}

function runProofCommand({ targetDir, proofDir }: LooseRecord) {
  if (dryRun) return;
  run("crabbox", zeroHrsAndroidProofRunArgs(), {
    cwd: targetDir,
    env: zeroHrsAndroidProofEnv(),
    timeoutMs: proofTimeoutMs,
  });

  copySourceProofRun({ targetDir, proofDir });
  validateSourceProofRun(proofDir);
}

function copySourceProofRun({ targetDir, proofDir }: LooseRecord) {
  const sourceProofDir = path.join(targetDir, "reports", "crabbox-android");
  if (fs.existsSync(sourceProofDir)) {
    fs.cpSync(sourceProofDir, proofDir, { recursive: true, force: true });
    return;
  }

  const artifactPath = findLatestCrabboxArtifactTarball(targetDir);
  if (artifactPath) {
    const extractedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-artifacts-"));
    try {
      run("tar", ["-xzf", artifactPath, "-C", extractedRoot, "reports/crabbox-android"], {
        timeoutMs: 60_000,
      });
      const extractedProofDir = path.join(extractedRoot, "reports", "crabbox-android");
      if (fs.existsSync(extractedProofDir)) {
        fs.cpSync(extractedProofDir, proofDir, { recursive: true, force: true });
        return;
      }
    } finally {
      fs.rmSync(extractedRoot, { recursive: true, force: true });
    }
  }

  throw new Error("Crabbox Android proof did not produce reports/crabbox-android");
}

function findLatestCrabboxArtifactTarball(targetDir: string) {
  const runsDir = path.join(targetDir, ".crabbox", "runs");
  if (!fs.existsSync(runsDir)) return null;
  const candidates: { path: string; mtimeMs: number }[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith("-artifacts.tgz")) continue;
      candidates.push({ path: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs });
    }
  };
  visit(runsDir);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

function zeroHrsAndroidProofRunArgs() {
  const host = process.env.CRABBOX_STATIC_HOST || process.env.HETZNER_IPV4 || "";
  if (!host)
    throw new Error("Missing HETZNER_IPV4 or CRABBOX_STATIC_HOST for Android proof runner");
  const args = [
    "run",
    "--reclaim",
    "--provider",
    "ssh",
    "--target",
    "linux",
    "--static-host",
    host,
    "--static-user",
    process.env.CRABBOX_STATIC_USER || "crabbox",
    "--static-port",
    process.env.CRABBOX_STATIC_PORT || "22",
    "--static-work-root",
    process.env.CRABBOX_STATIC_WORK_ROOT || "/work/crabbox",
    "--no-hydrate",
    "--label",
    "ZeroHrs Android feedback proof",
    "--artifact-glob",
    "reports/crabbox-android/**",
  ];
  for (const artifact of REQUIRED_REMOTE_PROOF_FILES) {
    args.push("--require-artifact", artifact);
  }
  args.push("--stop-after", "success", "--shell", "--", "bash scripts/crabbox/android-proof.sh");
  return args;
}

function zeroHrsAndroidProofEnv() {
  return {
    ...process.env,
    CRABBOX_STATIC_HOST: process.env.CRABBOX_STATIC_HOST || process.env.HETZNER_IPV4 || "",
    ZEROHRS_ANDROID_PROOF_DIR: "reports/crabbox-android",
  };
}

function validateSourceProofRun(proofDir: string) {
  for (const name of REQUIRED_PROOF_FILES) {
    const filePath = path.join(proofDir, name);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) {
      throw new Error(`Crabbox Android proof did not produce a valid ${name}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(proofDir, "proof-manifest.json"), "utf8"));
  if (manifest.status !== "completed") {
    throw new Error(`Crabbox Android proof manifest status is ${manifest.status ?? "missing"}`);
  }
}

function composeBeforeAfterProof({
  beforeDir,
  afterDir,
  outputDir,
  prNumber,
  beforeRef,
  afterRef,
  beforeSha,
  afterSha,
}: {
  beforeDir: string;
  afterDir: string;
  outputDir: string;
  prNumber: number;
  beforeRef: JsonValue;
  afterRef: JsonValue;
  beforeSha: JsonValue;
  afterSha: JsonValue;
}) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  copyProofFile(beforeDir, outputDir, "before-loading.png");
  copyProofFile(beforeDir, outputDir, "before.mp4");
  copyProofFile(beforeDir, outputDir, "before.png");
  copyProofFile(afterDir, outputDir, "after-loading.png");
  copyProofFile(afterDir, outputDir, "after.mp4");
  copyProofFile(afterDir, outputDir, "after.png");
  writeCombinedLog(outputDir, "command.log", beforeDir, afterDir);
  writeCombinedLog(outputDir, "emulator.log", beforeDir, afterDir);
  writeCombinedLog(outputDir, "app.log", beforeDir, afterDir);
  fs.writeFileSync(
    path.join(outputDir, "proof-manifest.json"),
    `${JSON.stringify(
      {
        proof_schema_version: 1,
        status: "completed",
        pr: `#${prNumber}`,
        before: {
          ref: beforeRef,
          sha: beforeSha,
          source: "main",
        },
        after: {
          ref: afterRef,
          sha: afterSha,
          source: "fix_pr",
        },
        captures: {
          before: {
            loading_screenshot: "before-loading.png",
            screenshot: "before.png",
            recording: "before.mp4",
          },
          after: {
            loading_screenshot: "after-loading.png",
            screenshot: "after.png",
            recording: "after.mp4",
          },
        },
        artifacts: REQUIRED_PROOF_FILES,
      },
      null,
      2,
    )}\n`,
  );
}

function copyProofFile(fromDir: string, toDir: string, name: string) {
  fs.copyFileSync(path.join(fromDir, name), path.join(toDir, name));
}

function writeCombinedLog(outputDir: string, name: string, beforeDir: string, afterDir: string) {
  const before = fs.readFileSync(path.join(beforeDir, name), "utf8");
  const after = fs.readFileSync(path.join(afterDir, name), "utf8");
  fs.writeFileSync(
    path.join(outputDir, name),
    [`# current main ${name}`, before, "", `# fixed branch ${name}`, after, ""].join("\n"),
  );
}

function baseHeadSha(targetDir: string) {
  return run("git", ["rev-parse", "HEAD"], { cwd: targetDir, timeoutMs: 60_000 }).trim();
}

function validateProofFiles(proofDir: string) {
  const manifestPath = path.join(proofDir, "proof-manifest.json");
  const files = REQUIRED_PROOF_FILES.map((name) => {
    const filePath = path.join(proofDir, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`missing Android proof artifact: ${name}`);
    }
    const size = fs.statSync(filePath).size;
    if (size <= 0) {
      throw new Error(`empty Android proof artifact: ${name}`);
    }
    return { name, size };
  });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.status !== "completed") {
    throw new Error(`Android proof manifest status is ${manifest.status ?? "missing"}`);
  }
  for (const field of [
    manifest?.captures?.before?.loading_screenshot,
    manifest?.captures?.before?.recording,
    manifest?.captures?.after?.loading_screenshot,
    manifest?.captures?.after?.recording,
  ]) {
    if (typeof field !== "string" || !field.trim()) {
      throw new Error("Android proof manifest is missing structured before/after media metadata");
    }
  }
  return files;
}

function publishProofAssets({
  proofDir,
  prNumber,
  headSha,
  proofFiles,
}: {
  proofDir: string;
  prNumber: number;
  headSha: JsonValue;
  proofFiles: LooseRecord[];
}) {
  const { prefix, urls } = buildProofAssetUrls({ prNumber, headSha });

  if (dryRun) return { prefix, urls };

  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-assets-"));
  if (remoteBranchExists(PROOF_ASSET_BRANCH)) {
    run(
      "git",
      [
        "clone",
        "--depth=1",
        "--branch",
        PROOF_ASSET_BRANCH,
        `https://github.com/${ZEROHRS_REPO}.git`,
        assetsDir,
      ],
      { env: gitAuthEnv(), timeoutMs: 5 * 60 * 1000 },
    );
  } else {
    cloneZeroHrsRepo(assetsDir, ["--filter=blob:none"]);
    run("git", ["checkout", "--orphan", PROOF_ASSET_BRANCH], {
      cwd: assetsDir,
      timeoutMs: 60_000,
    });
    run("git", ["rm", "-rf", "."], {
      cwd: assetsDir,
      timeoutMs: 60_000,
    });
  }
  run("git", ["config", "user.name", process.env.CLAWSWEEPER_GIT_USER_NAME || "clawsweeper[bot]"], {
    cwd: assetsDir,
    timeoutMs: 60_000,
  });
  run(
    "git",
    [
      "config",
      "user.email",
      process.env.CLAWSWEEPER_GIT_USER_EMAIL ||
        "274271284+clawsweeper[bot]@users.noreply.github.com",
    ],
    { cwd: assetsDir, timeoutMs: 60_000 },
  );

  const targetPrefix = path.join(assetsDir, prefix);
  fs.mkdirSync(targetPrefix, { recursive: true });
  for (const { name } of proofFiles) {
    fs.copyFileSync(path.join(proofDir, name), path.join(targetPrefix, name));
  }
  run("git", ["add", prefix], { cwd: assetsDir, timeoutMs: 60_000 });
  const status = run("git", ["status", "--porcelain", "--", prefix], {
    cwd: assetsDir,
    timeoutMs: 60_000,
  });
  if (status.trim()) {
    run("git", ["commit", "-m", `Add Android proof media for PR #${prNumber}`], {
      cwd: assetsDir,
      timeoutMs: 60_000,
    });
    run("git", ["push", "origin", `HEAD:${PROOF_ASSET_BRANCH}`], {
      cwd: assetsDir,
      env: gitAuthEnv(),
      timeoutMs: 5 * 60 * 1000,
    });
  }
  return { prefix, urls };
}

function cloneZeroHrsRepo(targetDir: string, gitArgs: string[]) {
  run("git", ["clone", ...gitArgs, `https://github.com/${ZEROHRS_REPO}.git`, targetDir], {
    env: gitAuthEnv(),
    timeoutMs: 5 * 60 * 1000,
  });
}

function gitAuthEnv() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) {
    return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  }
  if (!gitAskpassPath) {
    gitAskpassPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-proof-git-auth-")),
      "askpass.sh",
    );
    fs.writeFileSync(
      gitAskpassPath,
      [
        "#!/usr/bin/env bash",
        'case "$1" in',
        "  *Username*) printf '%s\\n' 'x-access-token' ;;",
        "  *) printf '%s\\n' \"$ZEROHRS_PROOF_GIT_TOKEN\" ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
  }
  return {
    ...process.env,
    GIT_ASKPASS: gitAskpassPath,
    GIT_TERMINAL_PROMPT: "0",
    ZEROHRS_PROOF_GIT_TOKEN: token,
  };
}

function buildProofAssetUrls({ prNumber, headSha }: { prNumber: number; headSha: JsonValue }) {
  const runId = sanitizePathPart(process.env.GITHUB_RUN_ID || "local");
  const attempt = sanitizePathPart(process.env.GITHUB_RUN_ATTEMPT || "1");
  const sha = sanitizePathPart(String(headSha ?? "unknown").slice(0, 12) || "unknown");
  const prefix = `proof-media/pr-${prNumber}/run-${runId}-attempt-${attempt}-${sha}`;
  const rawBase = `https://raw.githubusercontent.com/${ZEROHRS_REPO}/${PROOF_ASSET_BRANCH}/${prefix}`;
  const urls = Object.fromEntries(MEDIA_FILES.map((name) => [name, `${rawBase}/${name}`]));
  return { prefix, urls };
}

function publishProofComment({
  prNumber,
  prUrl,
  headSha,
  published,
}: {
  prNumber: number;
  prUrl: JsonValue;
  headSha: JsonValue;
  published: LooseRecord;
}) {
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const marker = `${PROOF_MARKER_PREFIX} pr=${prNumber} -->`;
  const body = [
    marker,
    "## Android proof media",
    "",
    `ClawSweeper generated Android proof for ${prUrl}.`,
    `Head: \`${headSha ?? "unknown"}\``,
    runUrl ? `Workflow run: ${runUrl}` : null,
    "",
    "### Loading screenshots",
    "",
    `![Before loading](${published.urls["before-loading.png"]})`,
    "",
    `![After loading](${published.urls["after-loading.png"]})`,
    "",
    "### Recordings",
    "",
    `- Before recording: ${published.urls["before.mp4"]}`,
    `- After recording: ${published.urls["after.mp4"]}`,
    `- Manifest: ${published.urls["proof-manifest.json"]}`,
    `- Legacy before screenshot: ${published.urls["before.png"]}`,
    `- Legacy after screenshot: ${published.urls["after.png"]}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (dryRun) return { url: null, marker };

  const existing = findExistingProofComment(prNumber, marker);
  if (existing?.id) {
    const updated = ghJson<LooseRecord>([
      "api",
      "-X",
      "PATCH",
      `repos/${ZEROHRS_REPO}/issues/comments/${existing.id}`,
      "-f",
      `body=${body}`,
    ]);
    return { url: updated.html_url ?? existing.html_url ?? null, marker };
  }
  const created = ghJson<LooseRecord>([
    "api",
    "-X",
    "POST",
    `repos/${ZEROHRS_REPO}/issues/${prNumber}/comments`,
    "-f",
    `body=${body}`,
  ]);
  return { url: created.html_url ?? null, marker };
}

function findExistingProofComment(prNumber: number, marker: string) {
  const comments = ghJson<LooseRecord[]>([
    "api",
    `repos/${ZEROHRS_REPO}/issues/${prNumber}/comments?per_page=100`,
    "--paginate",
  ]);
  return comments.find((comment) => String(comment?.body ?? "").includes(marker)) ?? null;
}

function remoteBranchExists(branch: string) {
  try {
    ghText(["api", `repos/${ZEROHRS_REPO}/git/ref/heads/${branch}`], { attempts: 2 });
    return true;
  } catch {
    return false;
  }
}

function sanitizePathPart(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function readSiblingJson(name: string) {
  const file = path.join(runDir, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findLatestResultPath() {
  const runsRoot = path.join(repoRoot(), ".clawsweeper-repair", "runs");
  if (!fs.existsSync(runsRoot)) throw new Error("no run directory exists");
  const candidates: LooseRecord[] = [];
  for (const runName of fs.readdirSync(runsRoot)) {
    const candidate = path.join(runsRoot, runName, "result.json");
    if (fs.existsSync(candidate))
      candidates.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
  }
  candidates.sort((left: JsonValue, right: JsonValue) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("no result.json files found");
  return candidates[0].path;
}

function writeReport() {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
