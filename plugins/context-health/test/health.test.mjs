import assert from "node:assert/strict";
import test from "node:test";

import { analyzeThread, summarizeThreads } from "../scripts/health.mjs";

function thread(overrides = {}) {
  return {
    id: "thread-1",
    name: "Test task",
    preview: "Test task preview",
    cwd: "E:\\project",
    status: { type: "idle" },
    createdAt: 1,
    updatedAt: 2,
    gitInfo: null,
    ...overrides,
  };
}

function turn(id, items, status = "completed") {
  return { id, items, status };
}

test("compaction alone never becomes risk", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    type: "contextCompaction",
    id: `compact-${index}`,
  }));
  const result = analyzeThread({ thread: thread(), turns: [turn("turn-1", items)] });

  assert.equal(result.level, "watch");
  assert.notEqual(result.level, "risk");
  assert.equal(result.metrics.compactions, 5);
});

test("long context without semantic drift is watch, not risk", () => {
  const turns = Array.from({ length: 26 }, (_, index) =>
    turn(`turn-${index}`, [
      { type: "agentMessage", id: `message-${index}`, text: "x".repeat(5_000) },
    ]),
  );
  const result = analyzeThread({ thread: thread(), turns, hasMore: true });

  assert.equal(result.level, "watch");
  assert.equal(result.metrics.driftCorrections, 0);
});

test("repeated drift corrections and repeated failure become risk", () => {
  const items = [
    {
      type: "agentMessage",
      id: "agent-before-correction",
      text: "我会继续实现更多辅助功能。",
    },
    {
      type: "userMessage",
      id: "user-1",
      content: [{ type: "text", text: "你已经偏离计划，不要再增加额外功能。" }],
    },
    {
      type: "userMessage",
      id: "user-2",
      content: [{ type: "text", text: "还是不按计划，请回到目标。" }],
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      type: "plan",
      id: `plan-${index}`,
      text: `plan ${index}`,
    })),
    {
      type: "commandExecution",
      id: "command-1",
      command: "npm test",
      status: "failed",
      exitCode: 1,
    },
    {
      type: "commandExecution",
      id: "command-2",
      command: "npm   test",
      status: "failed",
      exitCode: 1,
    },
  ];
  const result = analyzeThread({ thread: thread(), turns: [turn("turn-1", items)] });

  assert.equal(result.level, "risk");
  assert.ok(result.signals.some((item) => item.code === "explicit_drift_correction"));
  assert.ok(result.signals.some((item) => item.code === "repeated_failed_command"));
});

test("one explicit correction remains watch until continuity evidence accumulates", () => {
  const result = analyzeThread({
    thread: thread(),
    turns: [
      turn("turn-1", [
        {
          type: "agentMessage",
          id: "agent-before-correction",
          text: "我准备扩大当前实现范围。",
        },
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "你偏离目标了，请先不要扩展范围。" }],
        },
      ]),
    ],
  });

  assert.equal(result.level, "watch");
});

test("initial scope constraints are instructions, not corrections", () => {
  const result = analyzeThread({
    thread: thread(),
    turns: [
      turn("turn-1", [
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "只做当前计划，不要增加额外功能，也不要过度设计。" }],
        },
        { type: "agentMessage", id: "agent-1", text: "我会按当前范围执行。" },
      ]),
    ],
  });

  assert.equal(result.level, "healthy");
  assert.equal(result.metrics.corrections, 0);
  assert.equal(result.metrics.driftCorrections, 0);
});

test("a later successful command clears repeated-failure escalation", () => {
  const result = analyzeThread({
    thread: thread(),
    turns: [
      turn("turn-1", [
        { type: "commandExecution", id: "fail-1", command: "npm test", status: "failed", exitCode: 1 },
        { type: "commandExecution", id: "fail-2", command: "npm test", status: "failed", exitCode: 1 },
        { type: "commandExecution", id: "pass-1", command: "npm test", status: "completed", exitCode: 0 },
      ]),
    ],
  });

  assert.equal(result.level, "healthy");
  assert.ok(!result.signals.some((item) => item.code === "repeated_failed_command"));
});

test("unreadable history is visible as watch", () => {
  const result = analyzeThread({ thread: thread(), historyError: "history did not load" });

  assert.equal(result.level, "watch");
  assert.equal(result.signals[0].code, "history_unreadable");
});

test("summary uses the most severe thread level", () => {
  assert.deepEqual(summarizeThreads([{ level: "healthy" }, { level: "risk" }]), {
    level: "risk",
    total: 2,
    healthy: 1,
    watch: 0,
    risk: 1,
    semanticReviewRequired: true,
  });
});
