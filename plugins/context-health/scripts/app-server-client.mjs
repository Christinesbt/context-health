import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 20_000;

function findOnPath(names) {
  const directories = (process.env.PATH || process.env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const name of names) {
    for (const directory of directories) {
      const candidate = path.join(directory.replace(/^"|"$/gu, ""), name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveCodexCommand() {
  const configured = process.env.CODEX_BIN || process.env.CODEX_CLI_PATH;
  if (configured) {
    if (existsSync(configured) || path.isAbsolute(configured)) return configured;
    return findOnPath([configured]) || configured;
  }

  if (process.platform === "win32") {
    return findOnPath(["codex.exe", "codex.cmd", "codex.bat", "codex.ps1", "codex"]) || "codex.exe";
  }
  return findOnPath(["codex"]) || "codex";
}

function spawnAppServer() {
  const codexCommand = resolveCodexCommand();
  const extension = path.extname(codexCommand).toLocaleLowerCase();
  const options = {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const commandShell = process.env.ComSpec || "cmd.exe";
    const commandLine = `""${codexCommand}" app-server"`;
    return spawn(commandShell, ["/d", "/s", "/c", commandLine], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }

  if (process.platform === "win32" && extension === ".ps1") {
    const powershell = findOnPath(["pwsh.exe", "powershell.exe"]) || "powershell.exe";
    return spawn(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", codexCommand, "app-server"],
      options,
    );
  }

  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return spawn(process.execPath, [codexCommand, "app-server"], options);
  }

  return spawn(codexCommand, ["app-server"], options);
}

export class AppServerClient {
  constructor() {
    this.process = spawnAppServer();
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.fatalError = null;

    this.started = new Promise((resolve, reject) => {
      this.process.once("spawn", resolve);
      this.process.once("error", reject);
    });

    this.lines = readline.createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4_000);
    });
    this.process.on("error", (error) => {
      this.fatalError = error;
      this.failPending(error);
    });
    this.process.stdin.on("error", (error) => {
      this.fatalError = error;
      this.failPending(error);
    });
    this.process.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      const error = new Error(`Codex app-server exited (${code ?? signal})${suffix}`);
      this.fatalError = error;
      this.failPending(error);
    });
  }

  static async connect() {
    const client = new AppServerClient();
    await client.started;
    await client.request("initialize", {
      clientInfo: {
        name: "context-health",
        title: "Context Health",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    await client.notify("initialized", {});
    return client;
  }

  handleLine(line) {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      const error = new Error(`Codex app-server returned invalid JSON: ${line.slice(0, 200)}`);
      this.fatalError = error;
      this.failPending(error);
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || "Codex app-server request failed");
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.writeMessage({
        id: message.id,
        error: { code: -32601, message: "Context Health does not implement client requests." },
      }).catch((error) => {
        this.fatalError = error;
        this.failPending(error);
      });
    }
  }

  writeMessage(message) {
    if (this.closed) return Promise.reject(new Error("Codex app-server client is closed."));
    if (this.fatalError) return Promise.reject(this.fatalError);

    return new Promise((resolve, reject) => {
      this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async request(method, params) {
    await this.started;
    if (this.closed) throw new Error("Codex app-server client is closed.");
    if (this.fatalError) throw this.fatalError;

    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const detail = this.stderr.trim();
        reject(new Error(`Codex app-server timed out on ${method}${detail ? `: ${detail}` : ""}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(String(id), { resolve, reject, timer });
    });

    try {
      await this.writeMessage({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(String(id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(id));
        pending.reject(error);
      }
    }
    return response;
  }

  async notify(method, params) {
    if (!this.closed) await this.writeMessage({ method, params });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.process.stdin.end();
    const killTimer = setTimeout(() => this.process.kill(), 750);
    killTimer.unref();
  }
}
