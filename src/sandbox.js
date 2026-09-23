/**
 * Isolated code execution.
 *
 * Two backends:
 *
 *   docker   Real isolation — no network, capped memory and CPU, read-only
 *            root, dropped capabilities, non-root user. Use this in production.
 *   process  A bare child process with a wall-clock timeout and output caps.
 *            Convenient for development. It is NOT a security boundary: the
 *            code can read the filesystem and open sockets. Never expose it to
 *            untrusted callers.
 *
 * The backend is chosen automatically unless RATCHET_SANDBOX is set. Whichever
 * runs, the result reports `durationMs`, which is what the caller is billed on.
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LANGUAGES = {
  python: { file: "main.py", image: "python:3.12-alpine", cmd: ["python", "-u"] },
  javascript: { file: "main.js", image: "node:22-alpine", cmd: ["node"] },
};

export const DEFAULT_LIMITS = {
  timeoutMs: 10_000,
  maxOutputBytes: 256 * 1024,
  memoryMb: 256,
  cpus: "1",
};

/** Cap output so a runaway print loop cannot exhaust our memory. */
function collector(maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(buf) {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
      size += Math.min(buf.length, room);
      if (buf.length > room) truncated = true;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

/** Is the Docker daemon actually up? Cached for the process lifetime. */
let dockerAvailable = null;
export async function hasDocker() {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execFileAsync("docker", ["info"], { timeout: 5_000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

export async function selectBackend() {
  const forced = process.env.RATCHET_SANDBOX;
  if (forced === "docker" || forced === "process") return forced;
  return (await hasDocker()) ? "docker" : "process";
}

/**
 * Run `code` and return what it produced plus how long it took.
 *
 * Never throws for ordinary failures — a crash, a timeout and a syntax error
 * are all normal results with a non-zero `exitCode`, because the caller is
 * billed for them either way.
 */
export async function run({ language, code, stdin = "", limits = {}, backend } = {}) {
  const lang = LANGUAGES[language];
  if (!lang) {
    throw new SandboxError(
      `unsupported language "${language}" (have: ${Object.keys(LANGUAGES).join(", ")})`,
    );
  }
  if (typeof code !== "string" || code.length === 0) {
    throw new SandboxError("code must be a non-empty string");
  }

  const lim = { ...DEFAULT_LIMITS, ...limits };
  const chosen = backend ?? (await selectBackend());

  const dir = await mkdtemp(join(tmpdir(), "ratchet-sbx-"));
  const started = process.hrtime.bigint();

  try {
    await writeFile(join(dir, lang.file), code, "utf8");

    const spec =
      chosen === "docker"
        ? dockerSpec({ lang, dir, lim })
        : { command: lang.cmd[0], args: [...lang.cmd.slice(1), join(dir, lang.file)], cwd: dir };

    const result = await execute({ ...spec, stdin, lim });
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

    return {
      ...result,
      durationMs: Math.round(durationMs * 100) / 100,
      language,
      backend: chosen,
      isolated: chosen === "docker",
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Docker invocation with the isolation actually turned on. */
function dockerSpec({ lang, dir, lim }) {
  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      "-i",
      "--network", "none",              // no egress at all
      "--memory", `${lim.memoryMb}m`,
      "--memory-swap", `${lim.memoryMb}m`, // no swap escape hatch
      "--cpus", String(lim.cpus),
      "--pids-limit", "128",            // no fork bombs
      "--read-only",                    // immutable root
      "--tmpfs", "/tmp:rw,size=64m,noexec",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", "1000:1000",
      "-v", `${dir}:/work:ro`,
      "-w", "/work",
      lang.image,
      ...lang.cmd,
      lang.file,
    ],
    cwd: dir,
  };
}

function execute({ command, args, cwd, stdin, lim }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Strip our own environment so credentials never leak into user code.
      env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd },
    });

    const out = collector(lim.maxOutputBytes);
    const err = collector(lim.maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, lim.timeoutMs);

    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));

    child.stdin.on("error", () => {}); // the child may exit before reading stdin
    child.stdin.end(stdin);

    const finish = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: out.text,
        stderr: spawnError ? `${err.text}\n${spawnError}`.trim() : err.text,
        exitCode,
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    };

    child.on("error", (e) => finish(127, `sandbox failed to start: ${e.message}`));
    child.on("close", (code, signal) => finish(code ?? (signal ? 137 : 1)));
  });
}

export class SandboxError extends Error {}
