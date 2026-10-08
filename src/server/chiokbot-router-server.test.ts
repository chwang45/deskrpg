import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { setMultiAgentTaskRunner } from "../lib/ai/router";
import { handleChiokbotRouterRequest } from "./chiokbot-router-server";

test("Chi-OkBot router HTTP returns executeMultiAgentTask finalAnswer", async (t) => {
  let seenPrivate: string | undefined = "unset";
  setMultiAgentTaskRunner(async (prompt, privateContext) => {
    seenPrivate = privateContext;
    return {
      plan: { subtasks: [], synthesisInstructions: "" },
      workerResults: [],
      finalAnswer: `seen:${prompt}`,
    };
  });
  t.after(() => setMultiAgentTaskRunner(null));

  const server = createServer((req, res) => {
    void handleChiokbotRouterRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/chiokbot/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userPrompt: "hello command",
      privateContext: "do-not-forward",
      instructions: "Reply to the Telegram command.",
    }),
  });
  const json = (await response.json()) as { finalAnswer?: string };
  assert.equal(response.status, 200);
  assert.equal(json.finalAnswer, "seen:hello command");
  assert.equal(seenPrivate, undefined);
});
