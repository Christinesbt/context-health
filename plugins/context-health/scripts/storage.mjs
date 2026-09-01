import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function contextHealthHome() {
  if (process.env.CONTEXT_HEALTH_HOME) {
    return path.resolve(process.env.CONTEXT_HEALTH_HOME);
  }
  if (process.platform === "win32" && existsSync("E:\\")) {
    return "E:\\CodexData\\context-health";
  }
  return path.join(os.homedir(), ".codex", "context-health");
}

export function normalizeProjectPath(projectPath) {
  const resolved = path.resolve(projectPath).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function projectHash(projectPath) {
  return createHash("sha256").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 24);
}

export function snapshotPathFor(projectPath) {
  return path.join(contextHealthHome(), "state", `${projectHash(projectPath)}.json`);
}

async function setPrivateMode(targetPath, mode) {
  if (process.platform !== "win32") await chmod(targetPath, mode);
}

export async function ensureDataLayout() {
  const root = contextHealthHome();
  const configDirectory = path.join(root, "config");
  const stateDirectory = path.join(root, "state");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    setPrivateMode(root, 0o700),
    setPrivateMode(configDirectory, 0o700),
    setPrivateMode(stateDirectory, 0o700),
  ]);

  const configPath = path.join(configDirectory, "projects.json");
  try {
    await writeFile(configPath, `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await setPrivateMode(configPath, 0o600);

  return { root, configPath, stateDirectory };
}

export async function loadProjectConfig(projectPath) {
  const { configPath } = await ensureDataLayout();
  const raw = await readFile(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Context Health config is not valid JSON (${configPath}): ${error.message}`);
  }

  if (config.version !== 1 || !Array.isArray(config.projects)) {
    throw new Error(`Context Health config must contain version 1 and a projects array: ${configPath}`);
  }

  const normalized = normalizeProjectPath(projectPath);
  const project = config.projects.find(
    (entry) => typeof entry?.root === "string" && normalizeProjectPath(entry.root) === normalized,
  );
  if (!project) return null;

  return {
    root: path.resolve(project.root),
    projectId: typeof project.projectId === "string" && project.projectId ? project.projectId : null,
    sessionPaths: Array.isArray(project.sessionPaths)
      ? project.sessionPaths.filter((value) => typeof value === "string").map((value) => path.resolve(value))
      : [],
    authority: Array.isArray(project.authority)
      ? project.authority.filter((value) => typeof value === "string" && value.trim())
      : [],
  };
}

export async function writeSnapshot(snapshot) {
  await ensureDataLayout();
  const snapshotPath = snapshotPathFor(snapshot.project.path);
  const temporaryPath = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, snapshotPath);
    await setPrivateMode(snapshotPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return snapshotPath;
}

function validateSnapshot(snapshot, snapshotPath) {
  if (
    snapshot?.version !== 1 ||
    typeof snapshot.project?.path !== "string" ||
    !snapshot.summary ||
    typeof snapshot.summary !== "object" ||
    !Array.isArray(snapshot.threads)
  ) {
    throw new Error(`Context Health snapshot has an unsupported structure: ${snapshotPath}`);
  }
  return snapshot;
}

export async function readSnapshot(projectPath) {
  const snapshotPath = snapshotPathFor(projectPath);
  let raw;
  try {
    raw = await readFile(snapshotPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Context Health snapshot is not valid JSON (${snapshotPath}): ${error.message}`);
  }
  return validateSnapshot(snapshot, snapshotPath);
}
