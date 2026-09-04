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
      --neutral: #777a72;
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
    button, input { font: inherit; }
    .shell { display: grid; gap: 10px; min-width: 0; max-width: 100%; }
    .top, .section-head {
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
    .picker, .stat, .notice, .task {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
    }
    .picker { padding: 10px; }
    .selection-note, .meta, .preview, .recommendation, .foot {
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .selection-note { margin-top: 5px; font-size: 11px; }
    .choices { display: grid; gap: 5px; max-height: 230px; overflow: auto; margin-top: 8px; }
    .choice {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding: 7px 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      cursor: pointer;
    }
    .choice:hover { border-color: var(--accent); }
    .choice input { margin: 3px 0 0; }
    .choice-title { font-weight: 600; overflow-wrap: anywhere; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 7px;
    }
    .stat { padding: 9px 10px; }
    .stat strong { display: block; font-size: 18px; line-height: 1.1; }
    .stat span, .meta, .foot { font-size: 11px; }
    .notice { padding: 9px 10px; color: var(--muted); }
    .tasks { display: grid; gap: 7px; max-height: 430px; overflow: auto; padding-right: 2px; }
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
    .badge.neutral { background: var(--neutral); }
    .preview, .meta, .recommendation { margin-top: 5px; }
    .signals { margin: 7px 0 0; padding-left: 17px; }
    .signals li + li { margin-top: 3px; }
    .recommendation { color: var(--text); }
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
        <div id="project" class="project">正在读取会话列表…</div>
      </div>
      <div class="actions">
        <span id="overall" class="badge neutral">未检查</span>
        <button id="refresh" class="refresh" type="button">保存并检查</button>
      </div>
    </div>
    <section class="picker" aria-label="检查会话选择">
      <div class="section-head">
        <strong>检查会话</strong>
        <span id="selected-count" class="meta">已选 0</span>
      </div>
      <div id="selection-note" class="selection-note">打开面板不会读取会话历史。</div>
      <div id="choices" class="choices"></div>
    </section>
    <section id="summary" class="summary" aria-label="健康汇总" hidden></section>
    <section id="notice" class="notice" aria-live="polite">尚未检查。选择会话后点击“保存并检查”。</section>
    <section id="tasks" class="tasks" aria-label="任务健康列表"></section>
    <div class="foot">仅检查已选会话 · 结果不写入插件状态文件 · 只提醒，不自动交接</div>
  </main>
  <script>
    const pending = new Map();
    let nextRequestId = 1;
    let latestDashboard = null;
    const REQUEST_TIMEOUT_MS = 30000;

    const levelLabel = { healthy: "健康", watch: "关注", risk: "风险" };
    const projectEl = document.getElementById("project");
    const overallEl = document.getElementById("overall");
    const summaryEl = document.getElementById("summary");
    const noticeEl = document.getElementById("notice");
    const tasksEl = document.getElementById("tasks");
    const choicesEl = document.getElementById("choices");
    const selectionNoteEl = document.getElementById("selection-note");
    const selectedCountEl = document.getElementById("selected-count");
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

    function selectedThreadIds() {
      return [...choicesEl.querySelectorAll("input[type=checkbox]:checked")].map(
        function (input) { return input.value; },
      );
    }

    function sameSelection(left, right) {
      if (left.length !== right.length) return false;
      const rightSet = new Set(right);
      return left.every(function (value) { return rightSet.has(value); });
    }

    function displayTime(value) {
      if (!value) return "时间未知";
      const milliseconds = value < 1000000000000 ? value * 1000 : value;
      return new Date(milliseconds).toLocaleString();
    }

    function updateSelectionState() {
      if (!latestDashboard) return;
      const selected = selectedThreadIds();
      const saved = latestDashboard.selection.selectedThreadIds || [];
      const changed = !sameSelection(selected, saved);
      selectedCountEl.textContent = "已选 " + selected.length;
      refreshButton.textContent = selected.length
        ? changed ? "保存并检查" : "刷新所选"
        : "保存空选择";

      const notes = ["打开面板不会读取会话历史。"];
      const missing = latestDashboard.selection.missingThreadIds || [];
      if (missing.length) notes.push(missing.length + " 个已保存会话不可用，下次保存时会移除。");
      if (latestDashboard.discovery.candidateListTruncated) {
        notes.push("仅列出最近 " + latestDashboard.discovery.candidateLimit + " 个会话。");
      }
      if (changed) notes.push("选择尚未保存。");
      selectionNoteEl.textContent = notes.join(" ");
    }

    function renderSelection(dashboard) {
      const selected = new Set(dashboard.selection.selectedThreadIds || []);
      choicesEl.replaceChildren();
      for (const task of dashboard.candidates || []) {
        const choice = element("label", "choice");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = task.id;
        checkbox.checked = selected.has(task.id);
        checkbox.addEventListener("change", updateSelectionState);
        const content = element("div", "");
        content.append(
          element("div", "choice-title", task.name),
          element("div", "meta", task.status + " · 更新于 " + displayTime(task.updatedAt)),
        );
        choice.append(checkbox, content);
        choicesEl.append(choice);
      }
      if (!(dashboard.candidates || []).length) {
        choicesEl.append(element("div", "notice", "这个项目没有可选择的非归档主任务。"));
      }
      updateSelectionState();
    }

    function addStat(value, label) {
      const box = element("div", "stat");
      box.append(element("strong", "", String(value)), element("span", "", label));
      summaryEl.append(box);
    }

    function renderResult(result) {
      summaryEl.replaceChildren();
      tasksEl.replaceChildren();
      if (!result) {
        summaryEl.hidden = true;
        overallEl.textContent = "未检查";
        overallEl.className = "badge neutral";
        noticeEl.className = "notice";
        noticeEl.textContent = "尚未检查。选择会话后点击“保存并检查”。";
        return;
      }

      const summary = result.summary;
      overallEl.textContent = levelLabel[summary.level] || summary.level;
      overallEl.className = "badge " + summary.level;
      summaryEl.hidden = false;
      addStat(summary.total, "已检查");
      addStat(summary.risk, "风险");
      addStat(summary.watch, "关注");
      addStat(summary.healthy, "健康");

      const missingAuthority = (result.project.authority || []).filter(function (item) {
        return !item.exists;
      });
      let notice = "扫描于 " + new Date(result.scannedAt).toLocaleString() + "。";
      if (result.scope.threadsTruncated || result.scope.projectDiscoveryTruncated) {
        notice += " 本次读取不完整。";
      }
      if (result.scope.missingSelectedThreads) {
        notice += " 有 " + result.scope.missingSelectedThreads + " 个已选会话不可用。";
      }
      if (!(result.project.authority || []).length) {
        notice += " 尚未配置权威文档，语义结论置信度较低。";
      } else if (missingAuthority.length) {
        notice += " 有 " + missingAuthority.length + " 份权威文档不存在。";
      } else if (result.interpretation.semanticReviewRequired) {
        notice += " 关注或风险项仍需语义复核。";
      } else {
        notice += " 暂无需要换任务的信号。";
      }
      noticeEl.className = "notice";
      noticeEl.textContent = notice;

      for (const task of result.threads || []) {
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
        ];
        if ((metrics.repeatedFailedCommand || 0) >= 2) {
          meta.push(String(metrics.repeatedFailedCommand) + " 次同一命令连续失败");
        }
        if (metrics.externalNetworkFailures) {
          meta.push(String(metrics.externalNetworkFailures) + " 个外部网络故障已忽略");
        }
        if (metrics.expectedSearchMisses) {
          meta.push(String(metrics.expectedSearchMisses) + " 次搜索无结果已忽略");
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
    }

    function render(dashboard) {
      if (!dashboard || !dashboard.project || !dashboard.selection) return;
      latestDashboard = dashboard;
      projectEl.textContent = dashboard.project.name + " · " + dashboard.project.path;
      renderSelection(dashboard);
      renderResult(dashboard.result);
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
      if (!latestDashboard) return;
      const threadIds = selectedThreadIds();
      refreshButton.disabled = true;
      refreshButton.textContent = threadIds.length ? "检查中…" : "保存中…";
      try {
        const args = {
          projectPath: latestDashboard.project.path,
          threadIds: threadIds,
          turnLimit: 30,
        };
        if (latestDashboard.project.projectId) args.projectId = latestDashboard.project.projectId;
        const result = await callTool("scan_project_context_health", args);
        render(result && (result.structuredContent || result));
      } catch (error) {
        noticeEl.className = "notice error";
        noticeEl.textContent = "检查失败：" + String(error && (error.message || error));
      } finally {
        refreshButton.disabled = false;
        updateSelectionState();
      }
    });

    if (window.openai && window.openai.toolOutput) {
      render(window.openai.toolOutput.structuredContent || window.openai.toolOutput);
    }
  </script>
</body>
</html>`;
