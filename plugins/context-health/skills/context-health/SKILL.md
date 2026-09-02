---
name: context-health
description: Check all Codex tasks in a project for semantic drift, repeated failures, stale assumptions, unreadable history, and excessive context load; then show a refreshable health dashboard and advise whether a new task handoff is warranted.
---

# Context Health

Use this skill when the user asks whether a project task or all tasks in a project still have healthy, trustworthy context.

## Required workflow

1. Resolve the inspected project's root directory. Use its Codex project ID when it is available; otherwise use the root path. Do not ask the user when the active project context already identifies it safely.
2. Call `scan_project_context_health` for that project. The scan covers non-archived primary tasks and stores only a bounded summary outside the inspected repository.
3. Treat the scan as evidence, not as the final semantic verdict. Context length and compaction are load signals. Compaction alone is normal and must not justify a handoff.
4. For every `watch` or `risk` task, semantically compare the available evidence against:
   - the latest explicit user Goal and constraints;
   - recent user corrections and scope decisions;
   - the current plan and actual progress;
   - configured authority documents, in their listed order;
   - current Git status/diff and the implementation that now exists.
5. Use the available task-reading capability to inspect the relevant task when the heuristic summary is insufficient. Keep observed facts, inferences, and unavailable evidence separate.
6. Call `render_context_health_dashboard` with the same project root so the user receives the inline card and its refresh button.
7. Explain the final result briefly. Recommend a new task only after semantic continuity is no longer trustworthy or the history can no longer be loaded reliably.

## Scope rules

- Focus on drift, unplanned feature expansion, local fixes that conflict with the whole design, repeated mistakes, stale project assumptions, and context that is too heavy to carry safely.
- Do not classify a task as risky from token/length/compaction signals alone.
- A single user correction is normally a `watch` signal. Repeated correction plus continued expansion, plan churn, or repeated failure can become `risk`.
- Ignore recognizable external transport failures such as DNS resolution, connection reset, and external connection timeout. Record them separately; do not let them raise the health score. A failed localhost connection is still project-local evidence and is not ignored.
- Remind only. Do not automatically fork, create a replacement task, send a handoff, interrupt active work, or compact a task.
- Do not edit the inspected project while checking health.
- Do not create health configuration or state inside the inspected project. The default Windows data root is `E:\CodexData\context-health`.
- If authority configuration is absent, say that the semantic verdict has lower confidence and name the missing source of truth instead of inventing one.

## Result language

- `healthy`: no material continuity problem was found; continue the current plan.
- `watch`: review Goal, plan, and current project state before adding more scope.
- `risk`: pause expansion, finish or stop at a safe atomic boundary, prepare a concise handoff, and continue in a new task after the user agrees.

Always state that the checker is an early-warning system, not proof that the model has forgotten information.
