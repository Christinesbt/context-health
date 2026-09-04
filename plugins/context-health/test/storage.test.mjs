import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contextHealthHome,
  loadProjectConfig,
  saveProjectSelection,
} from "../scripts/storage.mjs";

test("only selected task IDs persist and no health state directory is created", async (context) => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "context-health-test-"));
  const previousHome = process.env.CONTEXT_HEALTH_HOME;
  process.env.CONTEXT_HEALTH_HOME = temporaryHome;
  context.after(async () => {
    if (previousHome === undefined) delete process.env.CONTEXT_HEALTH_HOME;
    else process.env.CONTEXT_HEALTH_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  });

  const projectPath = path.join(temporaryHome, "project");
  assert.equal(await loadProjectConfig(projectPath), null);
  await assert.rejects(access(path.join(contextHealthHome(), "config")), { code: "ENOENT" });

  await saveProjectSelection({
    projectPath,
    projectId: "project-1",
    selectedThreadIds: ["thread-2", "thread-1", "thread-2", ""],
  });

  const project = await loadProjectConfig(projectPath);
  assert.equal(project.projectId, "project-1");
  assert.deepEqual(project.selectedThreadIds, ["thread-2", "thread-1"]);

  const config = JSON.parse(
    await readFile(path.join(contextHealthHome(), "config", "projects.json"), "utf8"),
  );
  assert.deepEqual(config.projects[0].selectedThreadIds, ["thread-2", "thread-1"]);
  await assert.rejects(access(path.join(contextHealthHome(), "state")), { code: "ENOENT" });
});
