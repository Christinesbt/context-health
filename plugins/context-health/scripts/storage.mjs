import { randomUUID } from "node:crypto";
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

async function setPrivateMode(targetPath, mode) {
  if (process.platform !== "win32") await chmod(targetPath, mode);
}

export async function ensureDataLayout() {
  const root = contextHealthHome();
  const configDirectory = path.join(root, "config");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    setPrivateMode(root, 0o700),
    setPrivateMode(configDirectory, 0o700),
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

  return { root, configPath };
}

async function readConfig(configPath) {
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
  return config;
}

function uniqueThreadIds(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.trim()))];
}

export async function loadProjectConfig(projectPath) {
  const configPath = path.join(contextHealthHome(), "config", "projects.json");
  let config;
  try {
    config = await readConfig(configPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
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
    selectedThreadIds: uniqueThreadIds(project.selectedThreadIds),
  };
}

export async function saveProjectSelection({ projectPath, projectId = null, selectedThreadIds }) {
  const { configPath } = await ensureDataLayout();
  const config = await readConfig(configPath);
  const root = path.resolve(projectPath);
  const normalizedRoot = normalizeProjectPath(root);
  const index = config.projects.findIndex(
    (entry) =>
      typeof entry?.root === "string" && normalizeProjectPath(entry.root) === normalizedRoot,
  );
  const existing = index >= 0 ? config.projects[index] : {};
  const project = {
    ...existing,
    root,
    selectedThreadIds: uniqueThreadIds(selectedThreadIds),
  };
  if (projectId) project.projectId = projectId;
  if (index >= 0) config.projects[index] = project;
  else config.projects.push(project);

  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
    await setPrivateMode(configPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { configPath, project };
}
