#!/usr/bin/env node
import type { LooseRecord } from "./json-types.js";
import { File } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand as run } from "./command-runner.js";
import { ghJsonWithRetry as ghJson, ghTextWithRetry as ghText } from "./github-cli.js";
import { parseArgs } from "./lib.js";

const ZEROHRS_REPO = "ZeroHrs-Org/zerohrs-app";
const PROOF_ASSET_BRANCH = "zerohrs-clawsweeper-proof-assets";
const PROOF_MARKER_PREFIX = "<!-- clawsweeper-zerohrs-android-review-proof";
const GITHUB_ATTACHMENT_IMAGE_LIMIT_BYTES = 10_000_000;
const GITHUB_ATTACHMENT_VIDEO_LIMIT_BYTES = 100_000_000;
const GITHUB_ATTACHMENT_OTHER_LIMIT_BYTES = 25_000_000;
const REQUIRED_LOG_FILES = ["proof-manifest.json", "command.log", "emulator.log", "app.log"];
const CURRENT_STATE_MEDIA_FILES = ["before-loading.png", "before.mp4", "before.png"];
const INLINE_ATTACHMENT_FILES = ["before-loading.png", "before.mp4", "before.png"];
const GITHUB_ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".mp4": "video/mp4",
};
let gitAskpassPath: string | null = null;

const args = parseArgs(process.argv.slice(2));
const proofRoot = path.resolve(String(args["proof-root"] ?? args._[0] ?? "review-proofs"));
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_ZEROHRS_PROOF_DRY_RUN === "1");
const reportPath =
  typeof args.report === "string"
    ? path.resolve(args.report)
    : path.join(proofRoot, "zerohrs-android-review-proof-report.json");

const report: LooseRecord = {
  repo: ZEROHRS_REPO,
  dry_run: dryRun,
  proof_root: proofRoot,
  proof_at: new Date().toISOString(),
  actions: [],
};

try {
  const actions = await publishReviewProofs();
  report.actions = actions;
  report.status = actions.some((action: LooseRecord) => action.status === "published")
    ? "published"
    : actions.some((action: LooseRecord) => action.status === "planned")
      ? "planned"
      : actions.some((action: LooseRecord) => action.status === "blocked")
        ? "blocked"
        : "skipped";
  writeReport();
} catch (error) {
  report.status = "failed";
  report.reason = String(error?.message ?? error);
  writeReport();
  throw error;
}

async function publishReviewProofs() {
  if (!fs.existsSync(proofRoot)) {
    return [
      {
        action: "zerohrs_android_review_proof",
        status: "skipped",
        reason: "proof root does not exist",
      },
    ];
  }

  const proofDirs = findProofDirs(proofRoot);
  if (proofDirs.length === 0) {
    return [
      {
        action: "zerohrs_android_review_proof",
        status: "skipped",
        reason: "no Android review proof manifests were found",
      },
    ];
  }

  const actions: LooseRecord[] = [];
  for (const proofDir of proofDirs) {
    actions.push(await publishReviewProof(proofDir));
  }
  return actions;
}

async function publishReviewProof(proofDir: string) {
  const manifestPath = path.join(proofDir, "proof-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const issueNumber = reviewProofIssueNumber(manifest);
  if (!issueNumber) {
    return {
      action: "zerohrs_android_review_proof",
      status: "blocked",
      proof_dir: path.relative(process.cwd(), proofDir),
      reason: "proof manifest is missing numeric item_number",
    };
  }

  const logFiles = validateFiles(proofDir, REQUIRED_LOG_FILES);
  const manifestStatus = String(manifest?.status ?? "").trim();
  if (manifestStatus !== "completed") {
    const comment = publishReviewProofComment({
      issueNumber,
      manifest,
      published: null,
      status: "blocked",
      reason: `Android review proof status is ${manifestStatus || "missing"}`,
    });
    return {
      action: "zerohrs_android_review_proof",
      status: dryRun ? "planned" : "blocked",
      issue: `#${issueNumber}`,
      issue_url: issueUrl(issueNumber),
      proof_dir: path.relative(process.cwd(), proofDir),
      comment_url: comment.url ?? null,
      files: logFiles,
      reason: `Android review proof status is ${manifestStatus || "missing"}`,
    };
  }

  const proofFiles = validateFiles(proofDir, [...REQUIRED_LOG_FILES, ...CURRENT_STATE_MEDIA_FILES]);
  validateCompletedReviewProofManifest(manifest);
  const published = publishProofAssets({ proofDir, issueNumber, proofFiles });
  const inlineMedia = await publishInlineProofAttachments({
    proofDir,
    proofFiles,
    fallbackUrls: published.urls,
  });
  const comment = publishReviewProofComment({
    issueNumber,
    manifest,
    published: { ...published, inlineMedia },
    status: "published",
    reason: "",
  });

  return {
    action: "zerohrs_android_review_proof",
    status: dryRun ? "planned" : "published",
    issue: `#${issueNumber}`,
    issue_url: issueUrl(issueNumber),
    proof_dir: path.relative(process.cwd(), proofDir),
    asset_branch: PROOF_ASSET_BRANCH,
    asset_prefix: published.prefix,
    inline_media: inlineMedia,
    comment_url: comment.url ?? null,
    files: proofFiles,
  };
}

function validateCompletedReviewProofManifest(manifest: LooseRecord) {
  const before = manifest?.captures?.before;
  if (before?.launcher_screen_detected === true) {
    throw new Error("Android review proof captured the Expo launcher instead of the app route");
  }
  for (const field of [before?.loading_screenshot, before?.recording, before?.screenshot]) {
    if (typeof field !== "string" || !field.trim()) {
      throw new Error("Android review proof manifest is missing structured current-state media");
    }
  }
}

function validateFiles(proofDir: string, names: string[]) {
  return names.map((name) => {
    const filePath = path.join(proofDir, name);
    if (!fs.existsSync(filePath)) throw new Error(`missing Android review proof artifact: ${name}`);
    const size = fs.statSync(filePath).size;
    if (size <= 0) throw new Error(`empty Android review proof artifact: ${name}`);
    return { name, size };
  });
}

function findProofDirs(root: string) {
  const dirs: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (fs.existsSync(path.join(current, "proof-manifest.json"))) {
      dirs.push(current);
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return dirs.sort();
}

function reviewProofIssueNumber(manifest: LooseRecord) {
  const value = Number(manifest?.item_number ?? manifest?.issue_number);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function publishProofAssets({
  proofDir,
  issueNumber,
  proofFiles,
}: {
  proofDir: string;
  issueNumber: number;
  proofFiles: LooseRecord[];
}) {
  const { prefix, urls } = buildProofAssetUrls({ issueNumber });
  if (dryRun) return { prefix, urls };

  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-review-proof-assets-"));
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
    run(
      "git",
      ["clone", "--filter=blob:none", `https://github.com/${ZEROHRS_REPO}.git`, assetsDir],
      {
        env: gitAuthEnv(),
        timeoutMs: 5 * 60 * 1000,
      },
    );
    run("git", ["checkout", "--orphan", PROOF_ASSET_BRANCH], {
      cwd: assetsDir,
      timeoutMs: 60_000,
    });
    run("git", ["rm", "-rf", "."], { cwd: assetsDir, timeoutMs: 60_000 });
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
    run("git", ["commit", "-m", `Add Android review proof media for issue #${issueNumber}`], {
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

function buildProofAssetUrls({ issueNumber }: { issueNumber: number }) {
  const runId = sanitizePathPart(process.env.GITHUB_RUN_ID || "local");
  const attempt = sanitizePathPart(process.env.GITHUB_RUN_ATTEMPT || "1");
  const sha = sanitizePathPart((process.env.GITHUB_SHA || "unknown").slice(0, 12) || "unknown");
  const prefix = `proof-media/issue-${issueNumber}/review-run-${runId}-attempt-${attempt}-${sha}`;
  const fileBase = `https://github.com/${ZEROHRS_REPO}/blob/${PROOF_ASSET_BRANCH}/${prefix}`;
  const urls = Object.fromEntries(
    [...REQUIRED_LOG_FILES, ...CURRENT_STATE_MEDIA_FILES].map((name) => [
      name,
      `${fileBase}/${name}`,
    ]),
  );
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

function publishReviewProofComment({
  issueNumber,
  manifest,
  published,
  status,
  reason,
}: {
  issueNumber: number;
  manifest: LooseRecord;
  published: LooseRecord | null;
  status: "published" | "blocked";
  reason: string;
}) {
  const runUrl = workflowRunUrl();
  const marker = `${PROOF_MARKER_PREFIX} issue=${issueNumber} -->`;
  const route = String(manifest?.reproduction_route ?? manifest?.captures?.before?.route ?? "");
  const statusLine =
    status === "published"
      ? "ClawSweeper captured current-state Android review proof by manually navigating the app UI."
      : `ClawSweeper could not capture current-state Android review proof: ${reason}`;
  const mediaLines =
    status === "published" && published
      ? [
          "### Current-state media",
          "",
          renderProofMediaLine("Loading screenshot", "before-loading.png", published),
          renderProofMediaLine("Recording", "before.mp4", published),
          renderProofMediaLine("Screenshot", "before.png", published),
          `- Manifest: ${published.urls["proof-manifest.json"]}`,
        ]
      : [
          "### Current-state media",
          "",
          "- No PNG/MP4 media was published because the proof run did not complete.",
        ];
  const body = [
    marker,
    "## Android review proof",
    "",
    statusLine,
    route ? `Route: \`${route}\`` : null,
    runUrl ? `Workflow run: ${runUrl}` : null,
    "",
    ...mediaLines,
  ]
    .filter(Boolean)
    .join("\n");

  if (dryRun) return { url: null, marker };

  const existing = findExistingProofComment(issueNumber, marker);
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
    `repos/${ZEROHRS_REPO}/issues/${issueNumber}/comments`,
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

function findExistingProofComment(issueNumber: number, marker: string) {
  const comments = ghJson<LooseRecord[]>([
    "api",
    `repos/${ZEROHRS_REPO}/issues/${issueNumber}/comments?per_page=100`,
    "--paginate",
  ]);
  return comments.find((comment) => String(comment?.body ?? "").includes(marker)) ?? null;
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
    Referer: `https://github.com/${ZEROHRS_REPO}/issues`,
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

function remoteBranchExists(branch: string) {
  try {
    ghText(["api", `repos/${ZEROHRS_REPO}/git/ref/heads/${branch}`], { attempts: 2 });
    return true;
  } catch {
    return false;
  }
}

function gitAuthEnv() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!gitAskpassPath) {
    gitAskpassPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "zerohrs-review-proof-git-auth-")),
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

function issueUrl(issueNumber: number) {
  return `https://github.com/${ZEROHRS_REPO}/issues/${issueNumber}`;
}

function workflowRunUrl() {
  return process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
}

function sanitizePathPart(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function writeReport() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
