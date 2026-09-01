import { scanProjectContextHealth } from "./scan-project.mjs";

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const projectPath = valueAfter(args, "--project");

if (!projectPath) {
  console.error("Usage: npm run scan -- --project <absolute-path> [--project-id <id>] [--max-threads <n>] [--turn-limit <n>] [--json]");
  process.exitCode = 2;
} else {
  try {
    const snapshot = await scanProjectContextHealth({
      projectPath,
      projectId: valueAfter(args, "--project-id"),
      maxThreads: Number(valueAfter(args, "--max-threads")) || undefined,
      turnLimit: Number(valueAfter(args, "--turn-limit")) || undefined,
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      const summary = snapshot.summary;
      console.log(`${snapshot.project.name}: ${summary.level}`);
      console.log(`风险 ${summary.risk} / 关注 ${summary.watch} / 健康 ${summary.healthy} / 共 ${summary.total}`);
      console.log(`快照: ${snapshot.storage.snapshotPath}`);
    }
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}
