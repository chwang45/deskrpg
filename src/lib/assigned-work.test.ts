import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatAssignedWork, resolveWorkFile, resultFileTokens } from "./assigned-work";

test("an empty roster says there is no card", () => {
  const text = formatAssignedWork([], "ko");
  assert.match(text, /배정된 카드가 없다/);
  assert.match(text, /업무 주제가 아니다/);
});

test("a finished card names only a file that exists", () => {
  const text = formatAssignedWork(
    [{ title: "용어 30", status: "done", file: "D:\\deck.pptx" }],
    "en",
  );
  assert.match(text, /done · 용어 30 · D:\\deck\.pptx/);
  assert.match(text, /Earlier replies in this chat are not evidence/);
});

test("a result sentence yields the deck path and not the prose", () => {
  const tokens = resultFileTokens(
    "Deck written: Presentation/임플란트전문용어30/implant_terms_30.pptx (title + 30 terms).",
  );
  assert.deepEqual(tokens, ["Presentation/임플란트전문용어30/implant_terms_30.pptx"]);
});

test("a path written under the profile folder resolves", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-"));
  const cwd = path.join(root, "Presentation");
  const file = path.join(cwd, "deck", "implant_terms_30.pptx");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  const hit = resolveWorkFile("Presentation/deck/implant_terms_30.pptx", cwd);
  assert.equal(hit, file);
});
