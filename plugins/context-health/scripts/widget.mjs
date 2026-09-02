export const DASHBOARD_URI = "ui://context-health/dashboard.html";

export const dashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: light-dark(#f7f7f5, #171817);
      --panel: light-dark(#ffffff, #222322);
      --line: light-dark(#deded8, #3b3c39);
      --text: light-dark(#20211f, #f2f2ee);
      --muted: light-dark(#676961, #aeb0a8);
      --healthy: #2f8f5b;
      --watch: #b87813;
      --risk: #c7463b;
      --accent: light-dark(#20211f, #f2f2ee);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    button { font: inherit; }
    .shell { display: grid; gap: 10px; min-width: 0; max-width: 100%; }
    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    h1 { margin: 0; font-size: 17px; letter-spacing: -0.02em; }
    .project { margin-top: 3px; color: var(--muted); overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .refresh {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 10px;
      color: var(--text);
      background: var(--panel);
      cursor: pointer;
      white-space: nowrap;
    }
    .refresh:hover { border-color: var(--accent); }
    .refresh:disabled { cursor: wait; opacity: 0.6; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 7px;
    }
    .stat, .notice, .task {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
    }
    .stat { padding: 9px 10px; }
    .stat strong { display: block; font-size: 18px; line-height: 1.1; }
    .stat span { color: var(--muted); font-size: 12px; }
    .notice { padding: 9px 10px; color: var(--muted); }
    .notice strong { color: var(--text); }
    .tasks { display: grid; gap: 7px; max-height: 560px; overflow: auto; padding-right: 2px; }
    .task { padding: 10px; min-width: 0; }
    .task-head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .task-title { font-weight: 650; overflow-wrap: anywhere; }
    .badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 2px 7px;
      color: white;
      font-size: 11px;
      font-weight: 650;
    }
    .badge.healthy { background: var(--healthy); }
    .badge.watch { background: var(--watch); }
    .badge.risk { background: var(--risk); }
    .preview, .meta, .recommendation { margin-top: 5px; color: var(--muted); overflow-wrap: anywhere; }
    .meta { font-size: 11px; }
    .signals { margin: 7px 0 0; padding-left: 17px; }
    .signals li + li { margin-top: 3px; }
    .recommendation { color: var(--text); }
    .foot { color: var(--muted); font-size: 11px; }
    .error { border-color: var(--risk); color: var(--risk); }
    @media (max-width: 520px) {
      .top { display: grid; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="top">
      <div>
        <h1>Context Health</h1>
        <div id="project" class="project">等待扫描结果…</div>
      </div>
      <div class="actions">
        <span id="overall" class="badge healthy">—</span>
        <button id="refresh" class="refresh" type="button">刷新项目</button>
      </div>
    </div>
    <section id="summary" class="summary" aria-label="健康汇总"></section>
    <section id="notice" class="notice" aria-live="polite">正在读取结果…</section>
    <section id="tasks" class="tasks" aria-label="任务健康列表"></section>
    <div class="foot">启发式预警 · 压缩本身不等于风险 · 只提醒，不自动交接</div>
  </main>
  <script>
    const pending = new Map();
    let nextRequestId = 1;
    let latestSnapshot = null;
    const REQUEST_TIMEOUT_MS = 30000;

    const levelLabel = { healthy: "健康", watch: "关注", risk: "风险" };
    const projectEl = document.getElementById("project");
    const overallEl = document.getElementById("overall");
    const summaryEl = document.getElementById("summary");
    const noticeEl = document.getElementById("notice");
    const tasksEl = document.getElementById("tasks");
    const refreshButton = document.getElementById("refresh");

    function element(tag, className, text) {
      const value = document.createElement(tag);
      if (className) value.className = className;
      if (text !== undefined) value.textContent = text;
      return value;
    }

    function bridgeRequest(method, params) {
      const id = nextRequestId++;
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error("面板请求超时，请重试。"));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
      });
    }

    function withTimeout(value) {
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          reject(new Error("面板请求超时，请重试。"));
        }, REQUEST_TIMEOUT_MS);
        Promise.resolve(value).then(
          function (result) {
            clearTimeout(timer);
            resolve(result);
          },
          function (error) {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    }

    async function callTool(name, args) {
      if (window.openai && typeof window.openai.callTool === "function") {
        return withTimeout(window.openai.callTool(name, args));
      }
      return bridgeRequest("tools/call", { name: name, arguments: args });
    }

    function addStat(value, label) {
      const box = element("div", "stat");
      box.append(element("strong", "", String(value)), element("span", "", label));
      summaryEl.append(box);
    }

    function render(snapshot) {
      if (!snapshot || !snapshot.summary || !snapshot.project) return;
      latestSnapshot = snapshot;
      const summary = snapshot.summary;
      projectEl.textContent = snapshot.project.name + " · " + snapshot.project.path;
      overallEl.textContent = levelLabel[summary.level] || summary.level;
      overallEl.className = "badge " + summary.level;

      summaryEl.replaceChildren();
      addStat(summary.total, "任务");
      addStat(summary.risk, "风险");
      addStat(summary.watch, "关注");
      addStat(summary.healthy, "健康");

      const scanned = new Date(snapshot.scannedAt).toLocaleString();
      const missingAuthority = (snapshot.project.authority || []).filter((item) => !item.exists);
      let notice = "扫描于 " + scanned + "，按 " + snapshot.project.match + " 匹配。";
      const scope = snapshot.scope || {};
      if (scope.projectDiscoveryTruncated) {
        notice += " 项目元数据读取达到上限，结果可能不完整。";
      }
      if (scope.threadDiscoveryTruncated) {
        notice += " 任务元数据读取达到上限，结果可能不完整。";
      } else if (scope.selectionTruncated) {
        notice += " 找到 " + scope.matchingThreads + " 个匹配任务，本次只分析最近 " + summary.total + " 个。";
      }
      if (!(snapshot.project.authority || []).length) {
        notice += " 尚未配置权威文档，语义结论置信度较低。";
      } else if (missingAuthority.length) {
        notice += " 有 " + missingAuthority.length + " 份权威文档不存在。";
      } else if (summary.semanticReviewRequired) {
        notice += " 请让 Codex 对关注/风险项做语义复核。";
      } else {
        notice += " 暂无需要换任务的信号。";
      }
      noticeEl.className = "notice";
      noticeEl.textContent = notice;

      tasksEl.replaceChildren();
      for (const task of snapshot.threads || []) {
        const card = element("article", "task");
        const head = element("div", "task-head");
        head.append(
          element("div", "task-title", task.name),
          element("span", "badge " + task.level, levelLabel[task.level] || task.level),
        );
        card.append(head);
        if (task.preview) card.append(element("div", "preview", task.preview));

        const metrics = task.metrics || {};
        const meta = [
          task.status,
          String(metrics.turnsLoaded || 0) + " 轮",
          String(metrics.compactions || 0) + " 次压缩",
          String((metrics.failedCommands || 0) + (metrics.failedTools || 0)) + " 个失败",
        ];
        if (metrics.externalNetworkFailures) {
          meta.push(String(metrics.externalNetworkFailures) + " 个外部网络故障已忽略");
        }
        card.append(element("div", "meta", meta.join(" · ")));

        if ((task.signals || []).length) {
          const list = element("ul", "signals");
          for (const item of task.signals) {
            list.append(element("li", "", item.label + " — " + item.evidence));
          }
          card.append(list);
        }
        card.append(element("div", "recommendation", task.recommendation));
        tasksEl.append(card);
      }

      if (!(snapshot.threads || []).length) {
        tasksEl.append(element("div", "notice", "这个范围内没有找到非归档主任务。"));
      }
    }

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;

      if (message.id !== undefined && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(message.error);
        else request.resolve(message.result);
        return;
      }

      if (message.method === "ui/notifications/tool-result") {
        render(message.params && message.params.structuredContent);
      }
    }, { passive: true });

    refreshButton.addEventListener("click", async function () {
      if (!latestSnapshot) return;
      refreshButton.disabled = true;
      refreshButton.textContent = "刷新中…";
      try {
        const args = {
          projectPath: latestSnapshot.project.path,
          maxThreads: latestSnapshot.scope.threadLimit,
          turnLimit: latestSnapshot.scope.turnLimit,
        };
        if (latestSnapshot.project.projectId) args.projectId = latestSnapshot.project.projectId;
        const result = await callTool("scan_project_context_health", args);
        render(result && (result.structuredContent || result));
      } catch (error) {
        noticeEl.className = "notice error";
        noticeEl.textContent = "刷新失败：" + String(error && (error.message || error));
      } finally {
        refreshButton.disabled = false;
        refreshButton.textContent = "刷新项目";
      }
    });

    if (window.openai && window.openai.toolOutput) {
      render(window.openai.toolOutput.structuredContent || window.openai.toolOutput);
    }
  </script>
</body>
</html>`;
