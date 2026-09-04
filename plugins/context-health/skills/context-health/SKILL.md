---
name: context-health
description: Let the user select specific Codex tasks in a project, check only those tasks for semantic drift, repeated failures, stale assumptions, unreadable history, and excessive context load, and display a lightweight health dashboard.
---

# Context Health

Use this skill when the user asks whether specific project tasks still have healthy, trustworthy context or asks to open the Context Health panel.

## Required workflow

1. Resolve the inspected project's root directory. Use its Codex project ID when available. Do not ask when the active project identifies it safely.
2. Call `render_context_health_dashboard` first. It lists bounded non-archived task metadata only; it does not read task histories or calculate health.
3. Let the user choose tasks in the panel. The panel saves only those task IDs and calls `scan_project_context_health`. An empty selection must remain empty and must never fall back to all project tasks.
4. Treat the selected-task scan as early-warning evidence. Context length and compaction are load signals; compaction alone must not justify a handoff.
5. For every selected `watch` or `risk` task, semantically compare the available evidence against:
   - the latest explicit user Goal and constraints;
   - recent user corrections and scope decisions;
   - the current plan and actual progress;
   - configured authority documents, in their listed order;
   - current Git status/diff and the implementation that now exists.
6. Read more evidence only for a selected task when the heuristic summary is insufficient. Keep observed facts, inferences, and unavailable evidence separate.
7. Explain the result briefly. Recommend a new task only after semantic continuity is no longer trustworthy or history can no longer be loaded reliably.

## Scope rules

- Focus on drift, unplanned feature expansion, local fixes that conflict with the whole design, repeated mistakes, stale project assumptions, and context that is too heavy to carry safely.
- Do not classify a task as risky from token/length/compaction signals alone.
- A single user correction is normally a `watch` signal. Repeated correction plus continued expansion, plan churn, or repeated failure can become `risk`.
- Ignore recognizable external transport failures such as DNS resolution, connection reset, and external connection timeout. Record them separately; do not let them raise the health score. A failed localhost connection is still project-local evidence and is not ignored.
- Remind only. Do not automatically fork, create a replacement task, send a handoff, interrupt active work, or compact a task.
- Do not edit the inspected project while checking health.
- Persist only the selected task IDs and optional project authority configuration under the plugin data root. Do not persist health results or history snapshots. The default Windows data root is `E:\CodexData\context-health`.
- Do not run background polling. Opening the panel is metadata-only; histories are read only after the user starts a selected-task check.
- Do not create health configuration or state inside the inspected project.
- If authority configuration is absent, say that the semantic verdict has lower confidence and name the missing source of truth instead of inventing one.

## Result language

- `healthy`: no material continuity problem was found; continue the current plan.
- `watch`: review Goal, plan, and current project state before adding more scope.
- `risk`: pause expansion, finish or stop at a safe atomic boundary, prepare a concise handoff, and continue in a new task after the user agrees.

Always state that the checker is an early-warning system, not proof that the model has forgotten information.
