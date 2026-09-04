import { scanProjectContextHealth } from "./scan-project.mjs";

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function valuesAfter(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

const args = process.argv.slice(2);
const projectPath = valueAfter(args, "--project");

if (!projectPath) {
  console.error("Usage: npm run scan -- --project <absolute-path> [--project-id <id>] [--thread-id <id>] [--max-threads <n>] [--turn-limit <n>] [--json]");
  process.exitCode = 2;
} else {
  try {
    const explicitThreadIds = args.includes("--thread-id") ? valuesAfter(args, "--thread-id") : undefined;
    const dashboard = await scanProjectContextHealth({
      projectPath,
      projectId: valueAfter(args, "--project-id"),
      threadIds: explicitThreadIds,
      maxThreads: Number(valueAfter(args, "--max-threads")) || undefined,
      turnLimit: Number(valueAfter(args, "--turn-limit")) || undefined,
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(dashboard, null, 2));
    } else if (!dashboard.result) {
      console.log(`${dashboard.project.name}: 未检查`);
      console.log(`已选择 ${dashboard.selection.selectedThreadIds.length} 个任务；没有可检查的已选任务。`);
    } else {
      const summary = dashboard.result.summary;
      console.log(`${dashboard.project.name}: ${summary.level}`);
      console.log(`风险 ${summary.risk} / 关注 ${summary.watch} / 健康 ${summary.healthy} / 共 ${summary.total}`);
      console.log("结果仅用于当前输出，插件不会写入健康状态文件。");
    }
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}
