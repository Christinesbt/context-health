import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectIndex = process.argv.indexOf("--project");
const projectPath = projectIndex >= 0 ? process.argv[projectIndex + 1] : null;

if (!projectPath) {
  console.error("Usage: npm run smoke -- --project <absolute-path>");
  process.exitCode = 2;
} else {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "context-health-smoke-"));
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
  childEnvironment.CONTEXT_HEALTH_HOME = temporaryHome;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "dist", "server.mjs")],
    cwd: pluginRoot,
    env: childEnvironment,
  });
  const client = new Client({ name: "context-health-smoke", version: "0.2.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["render_context_health_dashboard", "scan_project_context_health"],
    );

    const dashboard = await client.callTool({
      name: "render_context_health_dashboard",
      arguments: { projectPath },
    });
    assert.ok(dashboard.structuredContent?.project?.path);
    assert.equal(dashboard.structuredContent?.result, null);
    assert.ok(dashboard.structuredContent?.candidates?.length > 0);
    await assert.rejects(access(path.join(temporaryHome, "config")), { code: "ENOENT" });

    const selectedThreadId = dashboard.structuredContent.candidates[0].id;
    const scan = await client.callTool({
      name: "scan_project_context_health",
      arguments: {
        projectPath: dashboard.structuredContent.project.path,
        threadIds: [selectedThreadId],
        maxThreads: 3,
        turnLimit: 6,
      },
    });
    assert.deepEqual(scan.structuredContent?.selection?.selectedThreadIds, [selectedThreadId]);
    assert.equal(scan.structuredContent?.result?.summary?.total, 1);

    const reopened = await client.callTool({
      name: "render_context_health_dashboard",
      arguments: { projectPath: dashboard.structuredContent.project.path },
    });
    assert.deepEqual(reopened.structuredContent?.selection?.selectedThreadIds, [selectedThreadId]);
    assert.equal(reopened.structuredContent?.result, null);
    await assert.rejects(access(path.join(temporaryHome, "state")), { code: "ENOENT" });

    const resource = await client.readResource({ uri: "ui://context-health/dashboard.html" });
    assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app");
    assert.match(resource.contents[0]?.text || "", /保存并检查/u);
    console.log(
      `MCP smoke passed: selected-only scan, memory-only result, ${tools.tools.length} tools.`,
    );
  } finally {
    await client.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
}
