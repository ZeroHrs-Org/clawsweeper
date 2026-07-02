import assert from "node:assert/strict";
import test from "node:test";

import {
  hasDeterministicSecuritySignal,
  hasSecuritySignalText,
  parseArgs,
  parseSimpleYaml,
  renderPrompt,
  validateJob,
} from "../../dist/repair/lib.js";

test("parseArgs ignores package-manager double dash separators", () => {
  assert.deepEqual(parseArgs(["--", "jobs/openclaw/inbox/example.md"]), {
    _: ["jobs/openclaw/inbox/example.md"],
  });
  assert.deepEqual(parseArgs(["--mode", "autonomous", "--", "job.md", "--latest"]), {
    _: ["job.md"],
    latest: true,
    mode: "autonomous",
  });
});

test("renderPrompt loads tracked repair prompt templates", () => {
  const prompt = renderPrompt(
    {
      raw: "---\nrepo: openclaw/clawsweeper\ncluster_id: smoke\nmode: autonomous\nrefs:\n  - 1\n---\nRepair smoke.",
      frontmatter: {
        repo: "openclaw/clawsweeper",
        cluster_id: "smoke",
        mode: "autonomous",
        refs: [1],
      },
    },
    "autonomous",
  );
  assert.match(prompt, /## Job file/);
  assert.match(prompt, /Repair smoke\./);
});

test("renderPrompt includes ZeroHrs Android proof evidence when provided", () => {
  const prompt = renderPrompt(
    {
      raw: '---\nrepo: ZeroHrs-Org/zerohrs-app\ncluster_id: issue-zerohrs-org-zerohrs-app-274\nmode: plan\nallowed_actions:\n  - comment\ncandidates:\n  - "#274"\n---\nPlan issue.',
      frontmatter: {
        repo: "ZeroHrs-Org/zerohrs-app",
        cluster_id: "issue-zerohrs-org-zerohrs-app-274",
        mode: "plan",
        allowed_actions: ["comment"],
        candidates: ["#274"],
      },
    },
    "plan",
    {
      zeroHrsAndroidProofPrompt:
        "Planning/review evidence is current-state reproduction evidence only. Inspect before-loading.png and before.mp4 captured after manually navigating the real app UI.",
    },
  );

  assert.match(prompt, /## ZeroHrs Android proof evidence/);
  assert.match(prompt, /current-state reproduction evidence only/);
  assert.match(prompt, /before-loading\.png and before\.mp4/);
  assert.match(prompt, /manually navigating the real app UI/);
});

test("validateJob rejects unknown canonical job intents", () => {
  const frontmatter = parseSimpleYaml(`repo: openclaw/openclaw
cluster_id: smoke
mode: autonomous
job_intent: surprise
allowed_actions:
  - comment
candidates:
  - "#1"
`);
  assert.deepEqual(validateJob({ frontmatter }), ["unsupported job_intent: surprise"]);
});

test("security signal detection ignores non-security advisory wording", () => {
  assert.equal(
    hasSecuritySignalText(
      "pnpm lint:tmp:dynamic-import-warts (advisory-only; no new run-loop.ts advisory)",
    ),
    false,
  );
});

test("security signal detection keeps explicit security advisory wording", () => {
  assert.equal(hasSecuritySignalText("security advisory triage for GHSA-1234-5678-abcd"), true);
  assert.equal(hasSecuritySignalText("CVE-2026-12345 is routed to the security lane"), true);
  assert.equal(hasSecuritySignalText({ name: "security:sensitive" }), true);
});

test("deterministic security signals ignore prose credential wording", () => {
  assert.equal(
    hasDeterministicSecuritySignal({
      comments: [
        "Current main's Codex credential reader types expose codexHome, platform, and execSync, but no allowKeychainPrompt.",
      ],
    }),
    false,
  );
});

test("deterministic security signals accept labels and structured ClawSweeper markers", () => {
  assert.equal(hasDeterministicSecuritySignal({ labels: ["security:sensitive"] }), true);
  assert.equal(
    hasDeterministicSecuritySignal({
      comments: ["<!-- clawsweeper-security:security-sensitive item=123 sha=abc -->"],
    }),
    true,
  );
});
