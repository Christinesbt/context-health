import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeGitOrigin,
  sanitizeGitOrigin,
  threadBelongsToProject,
} from "../scripts/scan-project.mjs";

const scope = {
  projectId: "project-a",
  sessionPaths: ["E:\\projects\\alpha"],
  gitOrigin: "github.com/example/alpha",
};

test("a different nonempty projectId cannot fall back to path or Git matching", () => {
  const belongs = threadBelongsToProject(
    {
      projectId: "project-b",
      cwd: "E:\\projects\\alpha",
      gitInfo: { originUrl: "https://github.com/example/alpha.git" },
    },
    scope,
  );

  assert.equal(belongs, false);
});

test("an unassigned legacy thread may match by exact session path", () => {
  const belongs = threadBelongsToProject(
    { projectId: null, cwd: "E:\\projects\\alpha", gitInfo: null },
    scope,
  );

  assert.equal(belongs, true);
});

test("Git origins are stored without embedded credentials", () => {
  const sanitized = sanitizeGitOrigin(
    "https://automation-user:super-secret@github.com/example/alpha.git",
  );

  assert.equal(sanitized, "https://github.com/example/alpha.git");
  assert.ok(!sanitized.includes("automation-user"));
  assert.ok(!sanitized.includes("super-secret"));
});

test("scp-style SSH and HTTPS origins normalize to the same repository", () => {
  assert.equal(
    normalizeGitOrigin("git@github.com:example/alpha.git"),
    normalizeGitOrigin("https://github.com/example/alpha.git"),
  );
});
