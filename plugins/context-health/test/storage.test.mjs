import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSnapshot, snapshotPathFor, writeSnapshot } from "../scripts/storage.mjs";

function snapshot(projectPath, scannedAt) {
  return {
    version: 1,
    scannedAt,
    project: { path: projectPath },
    summary: { level: "healthy", total: 0, healthy: 0, watch: 0, risk: 0 },
    threads: [],
  };
}

test("snapshot replacement stays readable and rejects an unsupported structure", async (context) => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "context-health-test-"));
  const previousHome = process.env.CONTEXT_HEALTH_HOME;
  process.env.CONTEXT_HEALTH_HOME = temporaryHome;
  context.after(async () => {
    if (previousHome === undefined) delete process.env.CONTEXT_HEALTH_HOME;
    else process.env.CONTEXT_HEALTH_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  });

  const projectPath = path.join(temporaryHome, "project");
  await writeSnapshot(snapshot(projectPath, "first"));
  await writeSnapshot(snapshot(projectPath, "second"));
  assert.equal((await readSnapshot(projectPath)).scannedAt, "second");

  await writeFile(snapshotPathFor(projectPath), '{"version":2}\n', "utf8");
  await assert.rejects(
    readSnapshot(projectPath),
    /snapshot has an unsupported structure/u,
  );
});
