import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";

import { scanProjectContextHealth } from "./scan-project.mjs";
import { readSnapshot } from "./storage.mjs";
import { DASHBOARD_URI, dashboardHtml } from "./widget.mjs";

const server = new McpServer(
  { name: "context-health", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);

function resultText(snapshot, verb) {
  const summary = snapshot.summary;
  const authorityNote = snapshot.project.authority.length
    ? ""
    : " 尚未配置权威文档，语义复核置信度较低。";
  const truncationNote = snapshot.scope.threadsTruncated || snapshot.scope.projectDiscoveryTruncated
    ? " 本次结果不完整，请查看面板中的截断说明。"
    : "";
  return `${verb} ${summary.total} 个任务：风险 ${summary.risk}、关注 ${summary.watch}、健康 ${summary.healthy}。${authorityNote}${truncationNote} 压缩和长度只作为负载信号；请对关注/风险项结合 Goal、计划、权威文档和当前 Git 做语义复核。`;
}

server.registerResource("context-health-dashboard", DASHBOARD_URI, {}, async () => ({
  contents: [
    {
      uri: DASHBOARD_URI,
      mimeType: "text/html;profile=mcp-app",
      text: dashboardHtml,
      _meta: { ui: { prefersBorder: true } },
    },
  ],
}));

server.registerTool(
  "scan_project_context_health",
  {
    title: "Scan project context health",
    description:
      "Scan all non-archived primary Codex tasks assigned to a project. Returns explainable heuristic signals for drift, repeated failures, unreadable history, and context load. This is an early-warning scan; semantically review watch/risk tasks before recommending a handoff.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Absolute path to the project root."),
      projectId: z.string().min(1).optional().describe("Codex project ID when known."),
      maxThreads: z.number().int().min(1).max(100).optional(),
      turnLimit: z.number().int().min(1).max(100).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "正在检查项目上下文…",
      "openai/toolInvocation/invoked": "项目上下文检查完成。",
    },
  },
  async (input) => {
    const snapshot = await scanProjectContextHealth(input);
    return {
      structuredContent: snapshot,
      content: [{ type: "text", text: resultText(snapshot, "已扫描") }],
    };
  },
);

server.registerTool(
  "render_context_health_dashboard",
  {
    title: "Render context health dashboard",
    description:
      "Render the latest Context Health snapshot. Always call scan_project_context_health first, then pass snapshot.project.path to this tool.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Canonical project path returned by the scan."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: DASHBOARD_URI },
      "openai/outputTemplate": DASHBOARD_URI,
      "openai/toolInvocation/invoking": "正在打开健康面板…",
      "openai/toolInvocation/invoked": "健康面板已打开。",
    },
  },
  async ({ projectPath }) => {
    const snapshot = await readSnapshot(projectPath);
    if (!snapshot) {
      throw new Error("No Context Health snapshot exists for this project. Call scan_project_context_health first.");
    }
    return {
      structuredContent: snapshot,
      content: [{ type: "text", text: resultText(snapshot, "正在显示最近扫描的") }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
