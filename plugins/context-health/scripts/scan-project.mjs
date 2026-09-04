import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AppServerClient } from "./app-server-client.mjs";
import { analyzeThread, sortByHealth, summarizeThreads } from "./health.mjs";
import {
  contextHealthHome,
  loadProjectConfig,
  normalizeProjectPath,
  saveProjectSelection,
} from "./storage.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
const MAX_METADATA_PAGES = 100;

function isWithin(candidate, root) {
  const normalizedCandidate = normalizeProjectPath(candidate);
  const normalizedRoot = normalizeProjectPath(root);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

async function listProjects(client) {
  const projects = [];
  const seenCursors = new Set();
  let cursor;
  let pageCount = 0;
  do {
    const page = await client.request("project/list", { cursor, limit: 100 });
    projects.push(...page.data);
    cursor = page.nextCursor || undefined;
    pageCount += 1;
    if (cursor && seenCursors.has(cursor)) {
      return { projects, truncated: true };
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor && pageCount < MAX_METADATA_PAGES);
  return { projects, truncated: Boolean(cursor) };
}

async function listThreadPages(client, projectId) {
  const threads = [];
  const seenCursors = new Set();
  let cursor;
  let pageCount = 0;

  do {
    const page = await client.request("thread/list", {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: SOURCE_KINDS,
      archived: false,
      projectId,
      useStateDbOnly: false,
    });
    threads.push(...page.data);
    cursor = page.nextCursor || undefined;
    pageCount += 1;
    if (cursor && seenCursors.has(cursor)) {
      return { threads, truncated: true };
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor && pageCount < MAX_METADATA_PAGES);

  return { threads, truncated: Boolean(cursor) };
}

async function listCandidateThreads(client, projectId) {
  const pages = [];
  if (projectId) pages.push(await listThreadPages(client, projectId));
  pages.push(await listThreadPages(client, null));
  return {
    threads: pages.flatMap((page) => page.threads),
    truncated: pages.some((page) => page.truncated),
  };
}

export function sanitizeGitOrigin(originUrl) {
  const value = String(originUrl || "").trim();
  if (!value) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    try {
      const parsed = new URL(value);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/iu, "$1");
    }
  }

  return value.replace(/^[^/@\s]+@([^:\s]+):(.+)$/u, "$1/$2");
}

export function normalizeGitOrigin(originUrl) {
  if (!originUrl) return null;
  return sanitizeGitOrigin(originUrl)
    .replace(/^git@([^:]+):/iu, "$1/")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/iu, "")
    .replace(/[\\/]+$/u, "")
    .replace(/\.git$/iu, "")
    .toLocaleLowerCase();
}

function deduplicateThreads(threads) {
  const byId = new Map();
  for (const thread of threads) {
    const existing = byId.get(thread.id);
    if (
      !existing ||
      thread.updatedAt > existing.updatedAt ||
      (thread.updatedAt === existing.updatedAt && !existing.gitInfo && thread.gitInfo)
    ) {
      byId.set(thread.id, thread);
    }
  }
  return [...byId.values()];
}

export function threadBelongsToProject(thread, { projectId, sessionPaths, gitOrigin }) {
  if (thread.projectId) return Boolean(projectId && thread.projectId === projectId);
  if (
    sessionPaths.some(
      (sessionPath) => normalizeProjectPath(thread.cwd) === normalizeProjectPath(sessionPath),
    )
  ) {
    return true;
  }
  const threadOrigin = normalizeGitOrigin(thread.gitInfo?.originUrl);
  return Boolean(gitOrigin && threadOrigin && threadOrigin === gitOrigin);
}

function matchProjectById(projects, requestedProjectId) {
  if (requestedProjectId) {
    return projects.find((project) => project.id === requestedProjectId) || null;
  }
  return null;
}

function matchProjectByExactPath(projects, requestedPath) {
  return (
    projects.find((project) =>
      (project.roots || []).some(
        (root) => normalizeProjectPath(root.path) === normalizeProjectPath(requestedPath),
      ),
    ) || null
  );
}

function matchProjectByContainingPath(projects, requestedPath) {
  const matches = [];
  for (const project of projects) {
    for (const root of project.roots || []) {
      if (isWithin(requestedPath, root.path)) {
        matches.push({ project, root: root.path });
      }
    }
  }
  matches.sort((left, right) => right.root.length - left.root.length);
  return matches[0]?.project || null;
}

function canonicalProjectRoot(project, requestedPath) {
  if (!project) return requestedPath;
  const containingRoots = (project.roots || [])
    .map((root) => root.path)
    .filter((root) => isWithin(requestedPath, root))
    .sort((left, right) => right.length - left.length);
  return path.resolve(containingRoots[0] || project.roots?.[0]?.path || requestedPath);
}

async function gitOriginAt(projectPath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "config", "--get", "remote.origin.url"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    return normalizeGitOrigin(stdout);
  } catch {
    return null;
  }
}

async function matchProjectByGitOrigin(projects, requestedPath) {
  const requestedOrigin = await gitOriginAt(requestedPath);
  if (!requestedOrigin) return null;

  for (const project of projects) {
    for (const root of project.roots || []) {
      if ((await gitOriginAt(root.path)) === requestedOrigin) return project;
    }
  }
  return null;
}

async function currentGitInfo(projectPath) {
  try {
    const options = { encoding: "utf8", maxBuffer: 1024 * 1024 };
    const [{ stdout: sha }, { stdout: branch }, { stdout: originUrl }] = await Promise.all([
      execFileAsync("git", ["-C", projectPath, "rev-parse", "HEAD"], options),
      execFileAsync("git", ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"], options),
      execFileAsync("git", ["-C", projectPath, "config", "--get", "remote.origin.url"], options),
    ]);
    return {
      sha: sha.trim(),
      branch: branch.trim(),
      originUrl: sanitizeGitOrigin(originUrl),
    };
  } catch {
    return null;
  }
}

async function authorityStatus(projectPath, authority) {
  return Promise.all(
    authority.map(async (configuredPath, index) => {
      const absolutePath = path.isAbsolute(configuredPath)
        ? path.resolve(configuredPath)
        : path.resolve(projectPath, configuredPath);
      let exists = true;
      try {
        await access(absolutePath);
      } catch {
        exists = false;
      }
      return { order: index + 1, configuredPath, absolutePath, exists };
    }),
  );
}

async function mapWithConcurrency(items, concurrency, work) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorSummary(error) {
  return String(error?.message || error || "unknown history read error")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function threadOption(thread) {
  return {
    id: thread.id,
    name: thread.name || thread.preview?.slice(0, 80) || "未命名任务",
    status: thread.status?.type || "unknown",
    updatedAt: thread.updatedAt,
  };
}

export function selectThreadsById(threads, selectedThreadIds, limit = 100) {
  const requestedThreadIds = [
    ...new Set(
      (selectedThreadIds || []).filter(
        (threadId) => typeof threadId === "string" && threadId.trim(),
      ),
    ),
  ];
  const boundedThreadIds = requestedThreadIds.slice(0, Math.max(1, limit));
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return {
    selectedThreadIds: boundedThreadIds,
    threads: boundedThreadIds.map((threadId) => byId.get(threadId)).filter(Boolean),
    missingThreadIds: boundedThreadIds.filter((threadId) => !byId.has(threadId)),
    truncated: requestedThreadIds.length > boundedThreadIds.length,
  };
}

async function resolveProjectContext(client, {
  projectPath,
  projectId = null,
  maxThreads = 100,
} = {}) {
  if (typeof projectPath !== "string" || !projectPath.trim()) {
    throw new Error("projectPath is required.");
  }

  const requestedPath = path.resolve(projectPath);
  const projectStat = await stat(requestedPath);
  if (!projectStat.isDirectory()) throw new Error(`projectPath is not a directory: ${requestedPath}`);

  const boundedMaxThreads = Math.max(1, Math.min(100, Number(maxThreads) || 100));
  let config = await loadProjectConfig(requestedPath);
  const projectDiscovery = await listProjects(client);
  const projects = projectDiscovery.projects;
  const configuredProjectId = projectId || config?.projectId;
  const matchedById = matchProjectById(projects, configuredProjectId);
  if (configuredProjectId && !matchedById) {
    const suffix = projectDiscovery.truncated ? "（项目列表读取不完整）" : "";
    throw new Error(`Codex projectId does not exist: ${configuredProjectId}${suffix}`);
  }
  const matchedByExactPath = matchProjectByExactPath(projects, requestedPath);
  const matchedByGitOrigin =
    matchedById || matchedByExactPath
      ? null
      : await matchProjectByGitOrigin(projects, requestedPath);
  const matchedByContainingPath =
    matchedById || matchedByExactPath || matchedByGitOrigin
      ? null
      : matchProjectByContainingPath(projects, requestedPath);
  const matchedProject =
    matchedById || matchedByExactPath || matchedByGitOrigin || matchedByContainingPath;
  const projectMatch = matchedById
    ? "projectId"
    : matchedByExactPath
      ? "exact-path"
      : matchedByGitOrigin
        ? "git-origin"
        : matchedByContainingPath
          ? "containing-path"
          : "unmatched";
  const canonicalPath = canonicalProjectRoot(matchedProject, requestedPath);
  config = (await loadProjectConfig(canonicalPath)) || config;
  const resolvedProjectId = projectId || config?.projectId || matchedProject?.id || null;
  const sessionPaths = [...new Set([canonicalPath, ...(config?.sessionPaths || [])])];
  const gitOrigin = await gitOriginAt(canonicalPath);
  const discovery = await listCandidateThreads(client, resolvedProjectId);
  const matchingThreads = deduplicateThreads(discovery.threads)
    .filter((thread) =>
      threadBelongsToProject(thread, {
        projectId: resolvedProjectId,
        sessionPaths,
        gitOrigin,
      }),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const configuredSelection = config?.selectedThreadIds || [];
  const firstCandidates = matchingThreads.slice(0, boundedMaxThreads);
  const firstCandidateIds = new Set(firstCandidates.map((thread) => thread.id));
  const configuredIds = new Set(configuredSelection);
  const selectedOutsideLimit = matchingThreads.filter(
    (thread) => configuredIds.has(thread.id) && !firstCandidateIds.has(thread.id),
  );

  return {
    requestedPath,
    canonicalPath,
    config,
    resolvedProjectId,
    sessionPaths,
    matchedProject,
    projectMatch,
    projectDiscovery,
    discovery,
    matchingThreads,
    candidateThreads: [...firstCandidates, ...selectedOutsideLimit],
    candidateLimit: boundedMaxThreads,
  };
}

function dashboardPayload(context, selectedThreadIds, result = null) {
  const selection = selectThreadsById(context.matchingThreads, selectedThreadIds);
  return {
    version: 2,
    project: {
      path: context.canonicalPath,
      requestedPath: context.requestedPath,
      projectId: context.resolvedProjectId,
      name: context.matchedProject?.name || path.basename(context.canonicalPath),
      match: context.projectMatch,
    },
    candidates: context.candidateThreads.map(threadOption),
    selection: {
      selectedThreadIds: selection.selectedThreadIds,
      missingThreadIds: selection.missingThreadIds,
      truncated: selection.truncated,
    },
    discovery: {
      candidateLimit: context.candidateLimit,
      matchingThreads: context.matchingThreads.length,
      candidatesShown: context.candidateThreads.length,
      projectDiscoveryTruncated: context.projectDiscovery.truncated,
      threadDiscoveryTruncated: context.discovery.truncated,
      candidateListTruncated: context.matchingThreads.length > context.candidateLimit,
    },
    result,
    persistence: {
      selection: "local-config",
      healthResults: "memory-only",
      dataRoot: contextHealthHome(),
    },
  };
}

export async function loadProjectContextHealthDashboard(input = {}) {
  const client = await AppServerClient.connect();
  try {
    const context = await resolveProjectContext(client, input);
    return dashboardPayload(context, context.config?.selectedThreadIds || []);
  } finally {
    client.close();
  }
}

export async function scanProjectContextHealth({
  projectPath,
  projectId = null,
  threadIds,
  maxThreads = 100,
  turnLimit = 30,
} = {}) {
  const boundedTurnLimit = Math.max(1, Math.min(100, Number(turnLimit) || 30));
  const client = await AppServerClient.connect();
  try {
    const context = await resolveProjectContext(client, { projectPath, projectId, maxThreads });
    const selectedThreadIds =
      threadIds === undefined ? context.config?.selectedThreadIds || [] : threadIds;
    if (threadIds !== undefined) {
      await saveProjectSelection({
        projectPath: context.canonicalPath,
        projectId: context.resolvedProjectId,
        selectedThreadIds,
      });
    }
    const selection = selectThreadsById(context.matchingThreads, selectedThreadIds);
    if (!selection.threads.length) {
      return dashboardPayload(context, selection.selectedThreadIds);
    }

    const git = await currentGitInfo(context.canonicalPath);
    const analyzedThreads = await mapWithConcurrency(selection.threads, 4, async (thread) => {
      try {
        const history = await client.request("thread/turns/list", {
          threadId: thread.id,
          limit: boundedTurnLimit,
          sortDirection: "desc",
          itemsView: "full",
        });
        return analyzeThread({
          thread,
          turns: history.data,
          hasMore: Boolean(history.nextCursor),
          currentGit: git,
        });
      } catch (error) {
        return analyzeThread({ thread, historyError: errorSummary(error), currentGit: git });
      }
    });

    const threads = sortByHealth(analyzedThreads);
    const authority = await authorityStatus(
      context.canonicalPath,
      context.config?.authority || [],
    );
    const scannedAt = new Date().toISOString();
    const result = {
      version: 1,
      scannedAt,
      project: {
        path: context.canonicalPath,
        requestedPath: context.requestedPath,
        projectId: context.resolvedProjectId,
        name: context.matchedProject?.name || path.basename(context.canonicalPath),
        match: context.projectMatch,
        sessionPaths: context.sessionPaths,
        authority,
      },
      git,
      scope: {
        turnLimit: boundedTurnLimit,
        selectedThreads: selection.threads.length,
        missingSelectedThreads: selection.missingThreadIds.length,
        selectionTruncated: selection.truncated,
        projectDiscoveryTruncated: context.projectDiscovery.truncated,
        threadDiscoveryTruncated: context.discovery.truncated,
        threadsTruncated: context.discovery.truncated || selection.truncated,
        matchingThreads: context.matchingThreads.length,
        sourceKinds: SOURCE_KINDS,
        archivedIncluded: false,
        subagentsIncluded: false,
      },
      summary: summarizeThreads(threads),
      threads,
      interpretation: {
        kind: "heuristic-early-warning",
        semanticReviewRequired: threads.some((thread) => thread.level !== "healthy"),
        compactionAloneIsRisk: false,
        automaticHandoff: false,
      },
      persistence: "memory-only",
    };

    return dashboardPayload(context, selection.selectedThreadIds, result);
  } finally {
    client.close();
  }
}
