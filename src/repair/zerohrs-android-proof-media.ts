#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import { File } from "node:buffer";
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
const EXECUTOR_PROOF_DIR = path.join("zerohrs-android-proof", "executor");
const GITHUB_ATTACHMENT_IMAGE_LIMIT_BYTES = 10_000_000;
const GITHUB_ATTACHMENT_VIDEO_LIMIT_BYTES = 100_000_000;
const GITHUB_ATTACHMENT_OTHER_LIMIT_BYTES = 25_000_000;
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
const MEDIA_FILES = [
  "proof-manifest.json",
  "before-loading.png",
  "after-loading.png",
  "before.mp4",
  "after.mp4",
  "before.png",
  "after.png",
];
const INLINE_ATTACHMENT_FILES = [
  "before-loading.png",
  "after-loading.png",
  "before.mp4",
  "after.mp4",
];
const GITHUB_ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".mp4": "video/mp4",
};

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const resultPathArg = args._[1];
const latest = Boolean(args.latest);
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_ZEROHRS_PROOF_DRY_RUN === "1");

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
  const action = await maybeRunZeroHrsProof();
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

async function maybeRunZeroHrsProof() {
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
  const executorProofDir = path.join(runDir, EXECUTOR_PROOF_DIR);
  if (!fs.existsSync(executorProofDir)) {
    return {
      action: "zerohrs_android_proof",
      status: "blocked",
      pr: `#${parsed.number}`,
      pr_url: view.url ?? fixPr.pr_url,
      head_sha: view.headRefOid ?? null,
      reason:
        "executor did not produce Android proof media under reports/clawsweeper/android-proof",
      expected_executor_path: "reports/clawsweeper/android-proof",
      collected_path: path.relative(repoRoot(), executorProofDir),
    };
  }

  const proofDir = path.join(proofRoot, `pr-${parsed.number}`);
  fs.rmSync(proofDir, { recursive: true, force: true });
  fs.mkdirSync(proofDir, { recursive: true });
  fs.cpSync(executorProofDir, proofDir, { recursive: true, force: true });

  const proofFiles = validateProofFiles(proofDir, {
    expectedHeadBranch: view.headRefName,
    expectedHeadSha: view.headRefOid,
  });
  const published = publishProofAssets({
    proofDir,
    prNumber: parsed.number,
    headSha: view.headRefOid,
    proofFiles,
  });
  const inlineMedia = await publishInlineProofAttachments({
    proofDir,
    proofFiles,
    fallbackUrls: published.urls,
  });
  const comment = publishProofComment({
    prNumber: parsed.number,
    prUrl: view.url ?? fixPr.pr_url,
    headSha: view.headRefOid,
    published: { ...published, inlineMedia },
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
    inline_media: inlineMedia,
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

function validateProofFiles(
  proofDir: string,
  expectedHead: { expectedHeadBranch?: JsonValue; expectedHeadSha?: JsonValue },
) {
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
  const beforeRef = firstManifestString(manifest, [
    ["before_ref"],
    ["before_sha"],
    ["before_branch"],
    ["refs", "before"],
    ["captures", "before", "ref"],
    ["captures", "before", "sha"],
    ["captures", "before", "branch"],
  ]);
  const afterRef = firstManifestString(manifest, [
    ["after_ref"],
    ["after_sha"],
    ["after_branch"],
    ["refs", "after"],
    ["captures", "after", "ref"],
    ["captures", "after", "sha"],
    ["captures", "after", "branch"],
  ]);
  if (!beforeRef || !afterRef) {
    throw new Error("Android proof manifest is missing before/after refs or branch names");
  }
  if (beforeRef === afterRef) {
    throw new Error("Android proof manifest before/after refs must differ");
  }
  if (!manifestAfterRefMatchesPullHead(afterRef, expectedHead)) {
    throw new Error(
      `Android proof manifest after_ref ${afterRef} does not match PR head ${String(expectedHead.expectedHeadSha ?? expectedHead.expectedHeadBranch ?? "").slice(0, 12)}`,
    );
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
  if (manifest?.captures?.before?.issue_reproduced !== true) {
    throw new Error("Android proof manifest must mark captures.before.issue_reproduced as true");
  }
  const beforeEvidence = firstManifestString(manifest, [
    ["captures", "before", "issue_evidence"],
    ["before_issue_evidence"],
  ]);
  if (!beforeEvidence) {
    throw new Error("Android proof manifest must include captures.before.issue_evidence");
  }
  if (manifest?.captures?.after?.issue_resolved !== true) {
    throw new Error("Android proof manifest must mark captures.after.issue_resolved as true");
  }
  const fixEvidence = firstManifestString(manifest, [
    ["captures", "after", "fix_evidence"],
    ["after_fix_evidence"],
  ]);
  if (!fixEvidence) {
    throw new Error("Android proof manifest must include captures.after.fix_evidence");
  }
  return files;
}

function manifestAfterRefMatchesPullHead(
  afterRef: string,
  expectedHead: { expectedHeadBranch?: JsonValue; expectedHeadSha?: JsonValue },
) {
  const normalizedAfterRef = normalizeManifestGitRef(afterRef);
  const headSha = String(expectedHead.expectedHeadSha ?? "")
    .trim()
    .toLowerCase();
  const headBranch = normalizeManifestGitRef(String(expectedHead.expectedHeadBranch ?? ""));
  if (headSha && refMatchesSha(normalizedAfterRef, headSha)) return true;
  return Boolean(
    headBranch &&
    (normalizedAfterRef === headBranch ||
      normalizedAfterRef === `origin/${headBranch}` ||
      normalizedAfterRef === `heads/${headBranch}`),
  );
}

function refMatchesSha(ref: string, sha: string) {
  const normalized = ref.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(normalized)) return false;
  return sha.startsWith(normalized) || normalized.startsWith(sha);
}

function normalizeManifestGitRef(ref: string) {
  return String(ref ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
}

function firstManifestString(manifest: LooseRecord, paths: string[][]) {
  for (const segments of paths) {
    const value = manifestValueAt(manifest, segments);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function manifestValueAt(value: JsonValue | undefined, segments: string[]) {
  let current: JsonValue | undefined = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as LooseRecord)[segment];
  }
  return current;
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
  const fileBase = `https://github.com/${ZEROHRS_REPO}/blob/${PROOF_ASSET_BRANCH}/${prefix}`;
  const urls = Object.fromEntries(MEDIA_FILES.map((name) => [name, `${fileBase}/${name}`]));
  return { prefix, urls };
}

async function publishInlineProofAttachments({
  proofDir,
  proofFiles,
  fallbackUrls,
}: {
  proofDir: string;
  proofFiles: LooseRecord[];
  fallbackUrls: LooseRecord;
}) {
  const cookie = process.env.ZEROHRS_GITHUB_USER_ATTACHMENT_COOKIE?.trim();
  const repoId = cookie ? fetchZeroHrsRepositoryId() : null;
  const results: LooseRecord = {};
  for (const name of INLINE_ATTACHMENT_FILES) {
    const file = proofFiles.find((candidate: LooseRecord) => candidate?.name === name);
    const size = Number(file?.size ?? fs.statSync(path.join(proofDir, name)).size);
    const limit = githubAttachmentLimitBytes(name);
    const fallbackUrl = String(fallbackUrls?.[name] ?? "");
    if (size > limit) {
      results[name] = {
        kind: "asset_link",
        url: fallbackUrl,
        fallback_url: fallbackUrl,
        size,
        limit,
        reason: "file exceeds GitHub comment attachment limit",
      };
      continue;
    }
    if (!cookie || !repoId) {
      results[name] = {
        kind: "asset_link",
        url: fallbackUrl,
        fallback_url: fallbackUrl,
        size,
        limit,
        reason: "GitHub attachment upload is not configured",
      };
      continue;
    }
    try {
      const attachment = await uploadGitHubUserAttachment({
        repositoryId: repoId,
        filePath: path.join(proofDir, name),
        fileName: name,
        cookie,
      });
      results[name] = {
        kind: "github_attachment",
        url: attachment.href,
        fallback_url: fallbackUrl,
        size,
        limit,
      };
    } catch (error) {
      results[name] = {
        kind: "asset_link",
        url: fallbackUrl,
        fallback_url: fallbackUrl,
        size,
        limit,
        reason: "GitHub attachment upload failed; using file link",
        error: String(error?.message ?? error).slice(0, 500),
      };
    }
  }
  return results;
}

function fetchZeroHrsRepositoryId() {
  const repo = ghJson<LooseRecord>(["api", `repos/${ZEROHRS_REPO}`, "--jq", ".id"]);
  const id = String(repo ?? "").trim();
  if (!id) throw new Error(`GitHub repository id was not returned for ${ZEROHRS_REPO}`);
  return id;
}

function githubAttachmentLimitBytes(name: string) {
  const ext = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif"].includes(ext)) return GITHUB_ATTACHMENT_IMAGE_LIMIT_BYTES;
  if ([".mp4", ".mov", ".webm"].includes(ext)) return GITHUB_ATTACHMENT_VIDEO_LIMIT_BYTES;
  return GITHUB_ATTACHMENT_OTHER_LIMIT_BYTES;
}

async function uploadGitHubUserAttachment({
  repositoryId,
  filePath,
  fileName,
  cookie,
}: {
  repositoryId: string;
  filePath: string;
  fileName: string;
  cookie: string;
}) {
  // GitHub has no public issue attachment API; this mirrors the web UI upload flow.
  const ext = path.extname(fileName).toLowerCase();
  const contentType = GITHUB_ATTACHMENT_CONTENT_TYPES[ext];
  if (!contentType) throw new Error(`unsupported GitHub attachment file type: ${fileName}`);
  const fileBytes = fs.readFileSync(filePath);
  const file = new File([fileBytes], fileName, { type: contentType });
  const policyForm = new FormData();
  policyForm.append("repository_id", repositoryId);
  policyForm.append("name", fileName);
  policyForm.append("size", String(file.size));
  policyForm.append("content_type", contentType);

  const policy = await githubUploadFetchJson("https://github.com/upload/policies/assets", {
    method: "POST",
    body: policyForm,
    headers: {
      ...githubAttachmentHeaders(cookie),
      "GitHub-Verified-Fetch": "true",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const uploadForm = new FormData();
  appendFormObject(uploadForm, policy.form);
  uploadForm.append("file", file, file.name);
  await githubUploadFetchText(String(policy.upload_url ?? ""), {
    method: "POST",
    body: uploadForm,
    headers: {
      ...githubAttachmentHeaders(cookie),
      ...objectToStringRecord(policy.header),
      ...(policy.same_origin
        ? { authenticity_token: String(policy.upload_authenticity_token ?? "") }
        : {}),
    },
  });
  const finalizeForm = new FormData();
  finalizeForm.append("authenticity_token", String(policy.asset_upload_authenticity_token ?? ""));
  const assetUploadPath = String(policy.asset_upload_url ?? "");
  await githubUploadFetchText(new URL(assetUploadPath, "https://github.com/").toString(), {
    method: "PUT",
    body: finalizeForm,
    headers: {
      ...githubAttachmentHeaders(cookie),
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const asset = policy.asset;
  if (!asset?.href) throw new Error("GitHub attachment upload did not return an asset href");
  return asset;
}

function githubAttachmentHeaders(cookie: string) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    Origin: "https://github.com",
    Referer: `https://github.com/${ZEROHRS_REPO}/pulls`,
    Cookie: cookie,
  };
}

async function githubUploadFetchJson(url: string, init: RequestInit) {
  const text = await githubUploadFetchText(url, init);
  return JSON.parse(text || "null") as LooseRecord;
}

async function githubUploadFetchText(url: string, init: RequestInit) {
  if (!url) throw new Error("GitHub attachment upload URL is missing");
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}: ${text.slice(0, 300)}`);
  }
  return text;
}

function appendFormObject(form: FormData, values: LooseRecord) {
  for (const [key, value] of Object.entries(objectToStringRecord(values))) {
    form.append(key, value);
  }
}

function objectToStringRecord(value: LooseRecord) {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    out[key] = String(item);
  }
  return out;
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
    renderProofMediaLine("Before loading screenshot", "before-loading.png", published),
    renderProofMediaLine("After loading screenshot", "after-loading.png", published),
    "",
    "### Recordings",
    "",
    renderProofMediaLine("Before recording", "before.mp4", published),
    renderProofMediaLine("After recording", "after.mp4", published),
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

function renderProofMediaLine(label: string, fileName: string, published: LooseRecord) {
  const inline = published?.inlineMedia?.[fileName];
  const url = String(inline?.url ?? published?.urls?.[fileName] ?? "");
  if (inline?.kind === "github_attachment") {
    return [
      `**${label}**`,
      "",
      renderGitHubAttachmentMarkdown(label, fileName, url),
      "",
      `Fallback file link: ${inline.fallback_url}`,
    ].join("\n");
  }
  const reason = inline?.reason ? ` (${inline.reason})` : "";
  return `- ${label}: ${url}${reason}`;
}

function renderGitHubAttachmentMarkdown(label: string, fileName: string, url: string) {
  const ext = path.extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif"].includes(ext)) return `![${label}](${url})`;
  return url;
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
