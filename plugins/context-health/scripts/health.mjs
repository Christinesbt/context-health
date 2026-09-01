const CORRECTION_PATTERN = /不要|别再|只需要|只做|先不要|先只|停止|停下|按(?:原|当前)?计划|保持范围|回到(?:目标|计划)|don't|do not|stop adding|only asked|stick to (?:the )?plan|stay focused|out of scope/iu;
const DRIFT_PATTERN = /你.{0,12}(?:偏离|跑偏)|偏离(?:任务|目标|计划)|跑偏|不按计划|不要.{0,16}(?:额外功能|发散|扩展范围)|过度设计|擅自(?:增加|修改)|整体而不是局部|scope creep|off[- ]track|unplanned feature|overengineer/iu;
const EXPANSION_PATTERN = /顺便|另外(?:还|也)|额外(?:增加|实现|补充)|同时(?:还|也)(?:增加|实现|补充)|while (?:i|we)(?:'m|'re| am| are) here|also (?:added|implemented)|in addition/iu;

const LEVEL_RANK = { healthy: 0, watch: 1, risk: 2 };

function userText(item) {
  if (item.type !== "userMessage") return "";
  return (item.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

function normalizedCommand(command) {
  return String(command || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase()
    .slice(0, 240);
}

function signal(code, severity, label, evidence) {
  return { code, severity, label, evidence };
}

function formatSize(characters) {
  if (characters < 1_000) return `${characters} 字符`;
  return `${Math.round(characters / 1_000)}k 字符`;
}

export function analyzeThread({ thread, turns = [], hasMore = false, historyError = null, currentGit = null }) {
  const orderedTurns = [...turns].sort(
    (left, right) => (left.startedAt || 0) - (right.startedAt || 0),
  );
  const items = orderedTurns.flatMap((turn) => turn.items || []);
  const commandStates = new Map();
  let userMessages = 0;
  let agentMessages = 0;
  let planUpdates = 0;
  let compactions = 0;
  let failedCommands = 0;
  let failedTools = 0;
  let failedTurns = 0;
  let corrections = 0;
  let driftCorrections = 0;
  let expansionCues = 0;
  let textCharacters = 0;
  let correctionSeen = false;
  let assistantSeen = hasMore;

  for (const turn of orderedTurns) {
    if (turn.status === "failed") failedTurns += 1;
  }

  for (const item of items) {
    if (item.type === "userMessage") {
      const text = userText(item);
      const isCorrection = CORRECTION_PATTERN.test(text);
      const isDriftCorrection = DRIFT_PATTERN.test(text);
      userMessages += 1;
      textCharacters += text.length;
      if (assistantSeen) {
        if (isCorrection) corrections += 1;
        if (isDriftCorrection) driftCorrections += 1;
        if (isCorrection || isDriftCorrection) correctionSeen = true;
      }
    } else if (item.type === "agentMessage") {
      agentMessages += 1;
      textCharacters += (item.text || "").length;
      if (correctionSeen && EXPANSION_PATTERN.test(item.text || "")) expansionCues += 1;
      assistantSeen = true;
    } else if (item.type === "plan") {
      planUpdates += 1;
      textCharacters += (item.text || "").length;
    } else if (item.type === "contextCompaction") {
      compactions += 1;
    } else if (item.type === "commandExecution") {
      const failed = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
      const key = normalizedCommand(item.command);
      const state = commandStates.get(key) || { currentFailureStreak: 0 };
      if (failed) {
        failedCommands += 1;
        if (key) {
          state.currentFailureStreak += 1;
          commandStates.set(key, state);
        }
      } else if (key && item.status === "completed" && (item.exitCode === null || item.exitCode === 0)) {
        state.currentFailureStreak = 0;
        commandStates.set(key, state);
      }
    } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
      if (item.status === "failed" || item.success === false) failedTools += 1;
    }
  }

  const repeatedFailedCommand = Math.max(
    0,
    ...[...commandStates.values()].map((state) => state.currentFailureStreak),
  );
  const heavyContext =
    hasMore ||
    turns.length >= 25 ||
    items.length >= 160 ||
    textCharacters >= 100_000 ||
    compactions >= 2;
  const veryHeavyContext =
    items.length >= 300 || textCharacters >= 200_000 || compactions >= 4;

  let score = 0;
  const signals = [];

  if (historyError) {
    score += 25;
    signals.push(
      signal(
        "history_unreadable",
        "watch",
        "会话历史无法可靠读取",
        String(historyError).slice(0, 180),
      ),
    );
  }

  if (heavyContext) {
    score += 15;
    if (veryHeavyContext) score += 10;
    signals.push(
      signal(
        "context_load",
        "watch",
        veryHeavyContext ? "近期上下文负载很重" : "近期上下文负载偏重",
        `${turns.length} 轮、${items.length} 项、${formatSize(textCharacters)}、${compactions} 次压缩${hasMore ? "，仍有更早历史" : ""}`,
      ),
    );
  }

  if (driftCorrections > 0) {
    score += 35 + Math.min(15, (driftCorrections - 1) * 8);
    signals.push(
      signal(
        "explicit_drift_correction",
        "risk",
        "出现明确的偏离或范围纠偏",
        `近期样本中检测到 ${driftCorrections} 次；需要结合原话语义复核。`,
      ),
    );
  }

  const otherCorrections = Math.max(0, corrections - driftCorrections);
  if (otherCorrections > 0) {
    score += Math.min(20, otherCorrections * 10);
    signals.push(
      signal(
        "scope_correction",
        "watch",
        "用户曾收窄范围或要求回到计划",
        `近期样本中检测到 ${otherCorrections} 次一般纠偏。`,
      ),
    );
  }

  if (repeatedFailedCommand >= 2) {
    score += 25;
    signals.push(
      signal(
        "repeated_failed_command",
        "risk",
        "同一失败操作重复出现",
        `同一命令签名最多连续累计 ${repeatedFailedCommand} 次失败。`,
      ),
    );
  }

  const totalFailures = failedCommands + failedTools + failedTurns;
  if (totalFailures >= 3) {
    score += 10;
    signals.push(
      signal(
        "failure_accumulation",
        "watch",
        "失败信号正在累积",
        `${failedCommands} 个命令失败、${failedTools} 个工具失败、${failedTurns} 个轮次失败。`,
      ),
    );
  }

  if (planUpdates >= 4 && corrections > 0) {
    score += 10;
    signals.push(
      signal(
        "plan_churn",
        "watch",
        "纠偏期间计划仍频繁变化",
        `近期样本包含 ${planUpdates} 次计划更新。`,
      ),
    );
  }

  if (expansionCues >= 3 && corrections > 0) {
    score += 10;
    signals.push(
      signal(
        "expansion_after_correction",
        "watch",
        "纠偏后仍有范围扩展措辞",
        `近期助手消息中检测到 ${expansionCues} 次弱扩展线索。`,
      ),
    );
  }

  if (
    currentGit?.sha &&
    thread.gitInfo?.sha &&
    currentGit.sha !== thread.gitInfo.sha &&
    (!currentGit.originUrl || !thread.gitInfo.originUrl || currentGit.originUrl === thread.gitInfo.originUrl)
  ) {
    signals.push(
      signal(
        "git_baseline_changed",
        "info",
        "会话起点与当前 Git 基线不同",
        "这通常是正常进展，但语义复核应确认旧计划仍适用。",
      ),
    );
  }

  score = Math.min(100, score);
  const continuedExpansion = expansionCues >= 3 && corrections > 0;
  let level = "healthy";
  if (
    score >= 60 &&
    driftCorrections >= 2 &&
    (repeatedFailedCommand >= 2 || continuedExpansion)
  ) {
    level = "risk";
  } else if (score >= 20 || heavyContext || historyError) {
    level = "watch";
  }

  const recommendation =
    level === "risk"
      ? "暂停继续扩展；先核对 Goal、计划和当前实现，再决定是否新开任务交接。"
      : level === "watch"
        ? "继续增加范围前做一次语义复核；若纠偏或加载问题重复，再准备交接。"
        : "未发现需要换任务的信号；按当前计划继续。";

  return {
    id: thread.id,
    name: thread.name || thread.preview?.slice(0, 80) || "未命名任务",
    preview: (thread.preview || "").replace(/\s+/g, " ").trim().slice(0, 180),
    cwd: thread.cwd,
    status: thread.status?.type || "unknown",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    level,
    score,
    confidence: "heuristic",
    metrics: {
      turnsLoaded: turns.length,
      itemCount: items.length,
      userMessages,
      agentMessages,
      planUpdates,
      compactions,
      failedCommands,
      failedTools,
      failedTurns,
      corrections,
      driftCorrections,
      expansionCues,
      textCharacters,
      hasMoreHistory: hasMore,
    },
    signals,
    recommendation,
  };
}

export function summarizeThreads(threads) {
  const counts = { healthy: 0, watch: 0, risk: 0 };
  for (const thread of threads) counts[thread.level] += 1;
  const level = counts.risk > 0 ? "risk" : counts.watch > 0 ? "watch" : "healthy";
  return {
    level,
    total: threads.length,
    ...counts,
    semanticReviewRequired: counts.risk + counts.watch > 0,
  };
}

export function sortByHealth(threads) {
  return [...threads].sort(
    (left, right) =>
      LEVEL_RANK[right.level] - LEVEL_RANK[left.level] || right.updatedAt - left.updatedAt,
  );
}
