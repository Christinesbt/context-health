# Context Health

Context Health 是一个本地 Codex 插件，用来检查同一项目下的任务是否仍然围绕原目标、计划和项目现状工作。

它优先发现这些问题：

- 用户已经多次纠偏，但任务仍然扩展范围或偏离计划；
- 同一失败操作反复出现，计划频繁变化却没有收敛；
- 会话过长、历史读取失败，已经不适合继续承载新任务；
- 会话所依据的目标、权威文档或 Git 状态可能已经过时。

上下文压缩和会话长度只是负载信号。单独发生压缩不会被判为风险。最终的“是否仍可信”需要 Codex 对照项目 Goal、计划、权威文档、最近纠偏和当前 Git 状态做语义复核。

## MVP 能力

- 综合 Codex 项目 ID、工作目录和 Git 远端身份，默认扫描该项目最近的 100 个非归档主任务（包括 Codex worktree 任务）；达到上限时会明确显示结果不完整。
- 返回健康、关注、风险三级结果，以及每项结果的可解释证据。
- 在对话中显示可刷新的内联卡片。
- 只提醒用户是否应准备新任务交接，不自动创建、分叉或发送消息到其他任务。
- 只持久化摘要、计数和有限长度的标题/预览，不复制完整会话或命令输出。

当前版本没有常驻后台进程。需要主动检查时，在项目任务中说“检查这个项目所有任务的上下文健康并显示面板”，或点击卡片里的“刷新项目”。

## 数据位置

Windows 默认使用：

```text
E:\CodexData\context-health
```

目录结构：

```text
E:\CodexData\context-health\
  config\projects.json
  state\<project-hash>.json
```

可以用 `CONTEXT_HEALTH_HOME` 覆盖位置。真实项目配置和扫描结果不在本仓库，也不会写入被检查项目的 Git 仓库。

第一次扫描会创建一个空的 `config\projects.json`。可按下面格式指定项目 ID、额外会话目录和权威文档顺序：

```json
{
  "version": 1,
  "projects": [
    {
      "root": "E:\\projects\\example",
      "projectId": "optional-codex-project-id",
      "sessionPaths": ["E:\\Codex\\worktrees\\example"],
      "authority": [
        "PRD.md",
        ".knowledge/base/strategy.md",
        ".knowledge/plan.md",
        ".knowledge/progress.md"
      ]
    }
  ]
}
```

`authority` 从高到低排列。它只声明语义复核时应读取什么，不会把文档内容复制到状态文件。

状态文件采用同目录临时文件替换，避免刷新中断留下半份 JSON。在 Windows 上，目录和文件继承 `E:\CodexData` 的 ACL；插件不会擅自修改系统权限。如果这块磁盘由多个系统用户共享，应由你限制 `E:\CodexData\context-health` 的访问权限。

## 运行前提

- Node.js 20 或更高版本；
- 当前用户可运行 Codex CLI 的 `app-server`；
- `codex` 可从 `PATH` 找到，或用 `CODEX_BIN` / `CODEX_CLI_PATH` 指向 Codex 可执行文件、脚本入口、`.cmd` 或 `.ps1`。

插件提交了已打包的 `dist/server.mjs`，安装者不需要在插件缓存中运行 `npm install`。它不是独立常驻 CLI，也不会额外启动后台守护进程。

## 本地开发

```powershell
cd E:\Codex\context-health\plugins\context-health
npm install
npm test
npm run build
npm run smoke -- --project E:\path\to\project
```

直接验证扫描器：

```powershell
npm run scan -- --project E:\path\to\project
```

## 安装

```powershell
codex plugin marketplace add E:\Codex\context-health
codex plugin add context-health@personal
```

安装或更新后新开一个 Codex 任务，插件 Skill 和 MCP 工具才会进入新任务的上下文。

## 已知边界

- 正在生成中的当前轮次可能还没有完整写入历史。
- 启发式扫描不会单独决定换任务；风险提醒需要语义复核确认。
- 默认最多分析最近 100 个匹配任务；项目或任务分页达到安全上限时，面板会标记结果不完整。
- 目前不主动后台轮询，也不会自动生成交接摘要或开启新任务。
- 默认只检查非归档主任务，避免把子代理和历史归档混入结果。
- 已有 Codex `projectId` 的任务只按该 ID 归属；只有旧的未分配任务才会回退到精确工作目录或脱敏后的 Git 远端身份。

## 设计参考

- [OpenAI Plugin UI 指南](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Codex App Server 协议](https://learn.chatgpt.com/docs/app-server)
- [codex-monitor-hud](https://github.com/LH-03/codex-monitor-hud)
- [Codex context health telemetry 讨论](https://github.com/openai/codex/issues/22220)
- [Codex semantic drift / handoff 讨论](https://github.com/openai/codex/issues/36584)
