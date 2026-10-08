/**
 * Loopback adapter so Chi-OkBot can call executeMultiAgentTask.
 * The DeskRPG server mounts POST /api/chiokbot/task on its own port.
 * The Cursor proxy posts the Telegram command here and replies with finalAnswer.
 * privateContext is never accepted on this socket.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeMultiAgentTask } from "../lib/ai/router";

const MAX_BODY_BYTES = 1_000_000;

function loadDeskRpgEnv(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const load = (
    process as typeof process & { loadEnvFile?: (path?: string) => void }
  ).loadEnvFile;
  if (!load) return;
  for (const name of [".env.local", ".env"]) {
    try {
      load(join(root, name));
    } catch {
      // Missing env file. Values already in the process stay as they are.
    }
  }
}

function requestPath(url: string | undefined): string {
  return (url || "/").split("?", 1)[0];
}

/** DeskRPG mounts only this path so the office homepage stays on Next. */
export function isDeskRpgChiokbotRoute(url: string | undefined, method: string | undefined): boolean {
  const path = requestPath(url);
  const verb = (method || "GET").toUpperCase();
  return path === "/api/chiokbot/task" && (verb === "GET" || verb === "POST");
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "router failed";
  return message.replace(/gsk_[A-Za-z0-9]+/g, "[redacted]").slice(0, 300);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  if (!res.headersSent) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(raw.length),
    });
  }
  res.end(raw);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

export async function handleChiokbotRouterRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = requestPath(req.url);
  try {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: "loopback only" });
      return;
    }
    if (req.method === "GET" && (path === "/health" || path === "/" || path === "/api/chiokbot/task")) {
      sendJson(res, 200, { ok: true, service: "chiokbot-multi-agent" });
      return;
    }
    if (req.method !== "POST" || (path !== "/task" && path !== "/api/chiokbot/task")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const body = await readJsonBody(req);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const userPrompt = typeof record.userPrompt === "string" ? record.userPrompt.trim() : "";
    if (!userPrompt) {
      sendJson(res, 400, { error: "userPrompt required" });
      return;
    }
    const instructions = typeof record.instructions === "string" ? record.instructions : undefined;
    const { finalAnswer } = await executeMultiAgentTask(userPrompt, undefined, {
      instructions,
    });
    sendJson(res, 200, { finalAnswer });
  } catch (error) {
    sendJson(res, 502, { error: publicError(error) });
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1]?.replace(/\\/g, "/");
  return Boolean(
    entry &&
      (entry.endsWith("/chiokbot-router-server.ts") || entry.endsWith("/chiokbot-router-server.js")),
  );
}

if (isDirectRun()) {
  loadDeskRpgEnv();
  const port = Number(process.env.CHIOKBOT_ROUTER_PORT || 18792);
  const server = createServer((req, res) => {
    void handleChiokbotRouterRequest(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`chiokbot router listening on http://127.0.0.1:${port}/task`);
  });
}
