import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";

import {
  loadProjectContextHealthDashboard,
  scanProjectContextHealth,
} from "./scan-project.mjs";
import { DASHBOARD_URI, dashboardHtml } from "./widget.mjs";

const server = new McpServer(
  { name: "context-health", version: "0.2.0" },
  { capabilities: { tools: {}, resources: {} } },
);

function resultText(dashboard, verb) {
  if (!dashboard.result) {
    const selected = dashboard.selection.selectedThreadIds.length;
    return `${verb}会话选择面板。已选择 ${selected} 个任务；尚未执行健康检查。检查结果不会写入插件数据目录。`;
  }
  const result = dashboard.result;
  const summary = result.summary;
  const authorityNote = result.project.authority.length
    ? ""
    : " 尚未配置权威文档，语义复核置信度较低。";
  const truncationNote = result.scope.threadsTruncated || result.scope.projectDiscoveryTruncated
    ? " 本次结果不完整，请查看面板中的截断说明。"
    : "";
  return `${verb} ${summary.total} 个已选任务：风险 ${summary.risk}、关注 ${summary.watch}、健康 ${summary.healthy}。${authorityNote}${truncationNote} 结果仅用于当前展示，不写入插件状态文件。`;
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
      "Check only the tasks explicitly selected for this project. When threadIds is provided, save that selection locally before checking. Never falls back to all project tasks.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Absolute path to the project root."),
      projectId: z.string().min(1).optional().describe("Codex project ID when known."),
      threadIds: z
        .array(z.string().min(1))
        .max(100)
        .optional()
        .describe("Selected Codex task IDs. Omit to use the saved selection."),
      maxThreads: z.number().int().min(1).max(100).optional().describe("Task picker limit."),
      turnLimit: z.number().int().min(1).max(100).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: DASHBOARD_URI },
      "openai/outputTemplate": DASHBOARD_URI,
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
      "Open the lightweight task picker without reading task histories or running a health check.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Absolute path to the project root."),
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
    const dashboard = await loadProjectContextHealthDashboard({ projectPath });
    return {
      structuredContent: dashboard,
      content: [{ type: "text", text: resultText(dashboard, "已打开") }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
