import assert from "node:assert/strict";
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "dist", "server.mjs")],
    cwd: pluginRoot,
  });
  const client = new Client({ name: "context-health-smoke", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["render_context_health_dashboard", "scan_project_context_health"],
    );

    const scan = await client.callTool({
      name: "scan_project_context_health",
      arguments: { projectPath, maxThreads: 3, turnLimit: 6 },
    });
    assert.ok(scan.structuredContent?.project?.path);

    const dashboard = await client.callTool({
      name: "render_context_health_dashboard",
      arguments: { projectPath: scan.structuredContent.project.path },
    });
    assert.equal(dashboard.structuredContent?.scannedAt, scan.structuredContent.scannedAt);

    const resource = await client.readResource({ uri: "ui://context-health/dashboard.html" });
    assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app");
    assert.match(resource.contents[0]?.text || "", /刷新项目/u);
    console.log(
      `MCP smoke passed: ${scan.structuredContent.summary.total} tasks, ${tools.tools.length} tools, dashboard resource loaded.`,
    );
  } finally {
    await client.close();
  }
}
