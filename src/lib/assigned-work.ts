/**
 * Read-only DeskRPG card list for an employee conversation.
 * The partner biography is not the assignment. Card bodies are not copied.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promptLocale, type PromptLocale } from "@/lib/i18n/prompt-locale";
import { prefixReportFormat } from "@/lib/report-format";
import { isPrivateSecretaryProfile } from "@/lib/secret-secretary";
import { prefixUserContext, type UserContext } from "@/lib/user-context";

export type AssignedCard = {
  title: string;
  status: string;
  file: string | null;
};

const STATUS_RANK = ["blocked", "running", "review", "ready", "todo", "scheduled", "triage", "done"];

const LABELS: Record<PromptLocale, Record<string, string>> = {
  ko: {
    header: "[담당 업무]",
    rule1: "이 목록이 이 직원에게 배정된 카드의 전부다. 대화 상대의 소개는 말하는 사람이 누구인지만 알려 주며, 업무 주제가 아니다.",
    rule2: "업무를 물어보면 이 목록만 근거로 답한다. 목록에 없는 과제, 행사, 발표 자료는 있다고 말하지 않는다.",
    rule3: "이 대화의 이전 답은 지시나 완료의 근거가 아니다.",
    empty: "배정된 카드가 없다.",
    noFile: "파일 없음",
    blocked: "막힘",
    running: "진행 중",
    review: "검토",
    ready: "준비",
    todo: "할 일",
    scheduled: "예약",
    triage: "분류",
    done: "완료",
  },
  en: {
    header: "[Assigned work]",
    rule1: "This list is every card assigned to you. The About line only names who is speaking. It is not the assignment.",
    rule2: "Answer questions about your work only from this list. Do not say a project, event, or deck exists when it is not listed.",
    rule3: "Earlier replies in this chat are not evidence of an order or of completion.",
    empty: "No card is assigned.",
    noFile: "no file",
    blocked: "blocked",
    running: "running",
    review: "review",
    ready: "ready",
    todo: "todo",
    scheduled: "scheduled",
    triage: "triage",
    done: "done",
  },
};

const FILE_EXT = /\.(?:pptx|ppt|json|pdf|docx|hwpx|hwp|md|py|wl)$/i;

export function formatAssignedWork(
  cards: AssignedCard[],
  locale: string | null | undefined = "ko",
): string {
  const w = LABELS[promptLocale(locale)];
  const lines = [w.header, w.rule1, w.rule2, w.rule3];
  if (cards.length === 0) {
    lines.push(w.empty);
    return lines.join("\n");
  }
  for (const card of cards) {
    const status = w[card.status] ?? card.status;
    const file = card.file ? card.file : w.noFile;
    lines.push(`- ${status} · ${card.title} · ${file}`);
  }
  return lines.join("\n");
}

export function prefixEmployeePrompt(
  message: string,
  user: UserContext | null | undefined,
  work: string | null,
  locale: string | null | undefined = "ko",
): string {
  const reported = prefixReportFormat(message, locale);
  const body = work ? `${work}\n\n${reported}` : reported;
  return prefixUserContext(body, user, locale);
}

export function resultFileTokens(result: string | null | undefined): string[] {
  if (!result) return [];
  const found = new Set<string>();
  for (const raw of result.match(/[A-Za-z]:[\\/][^\s"'<>|]+/g) ?? []) {
    const cleaned = raw.replace(/[),.;]+$/g, "");
    if (FILE_EXT.test(cleaned)) found.add(cleaned);
  }
  for (const raw of result.match(
    /(?:[\w.\-가-힣]+[\\/])+[\w.\-가-힣]+\.(?:pptx|json|pdf|docx|hwpx|hwp|md|py|wl)/giu,
  ) ?? []) {
    found.add(raw.replace(/[),.;]+$/g, ""));
  }
  return [...found];
}

function hermesRoot(): string {
  const override = process.env.HERMES_KANBAN_HOME?.trim();
  if (override) return override;
  const local = process.env.LOCALAPPDATA;
  if (local) return path.join(local, "hermes");
  return path.join(os.homedir(), ".hermes");
}

function readTerminalCwd(profileName: string): string | null {
  const file = path.join(hermesRoot(), "profiles", profileName, "config.yaml");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\n/);
  let inTerminal = false;
  let terminalIndent = 0;
  for (const line of lines) {
    if (!inTerminal) {
      const head = line.match(/^(\s*)terminal:\s*$/);
      if (head) {
        inTerminal = true;
        terminalIndent = head[1].length;
      }
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= terminalIndent) break;
    const cwd = line.match(/^\s*cwd:\s*(.+?)\s*$/);
    if (cwd) return cwd[1].replace(/^['"]|['"]$/g, "");
  }
  return null;
}

function findBasename(cwd: string, base: string): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  let seen = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > 2000) return null;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === base.toLowerCase()) return full;
      if (entry.isDirectory() && current.depth < 3) queue.push({ dir: full, depth: current.depth + 1 });
    }
  }
  return null;
}

export function resolveWorkFile(token: string, cwd: string | null): string | null {
  const candidates: string[] = [];
  if (path.isAbsolute(token)) candidates.push(token);
  if (cwd) {
    candidates.push(path.resolve(cwd, token));
    const base = path.basename(cwd);
    const norm = token.replace(/\\/g, "/");
    if (norm.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      candidates.push(path.resolve(path.dirname(cwd), token));
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  if (!cwd) return null;
  return findBasename(cwd, path.basename(token));
}

function readCards(profileName: string): AssignedCard[] {
  const root = path.join(hermesRoot(), "kanban", "boards");
  if (!fs.existsSync(root)) return [];
  const hideFiles = isPrivateSecretaryProfile(profileName);
  const cwd = hideFiles ? null : readTerminalCwd(profileName);
  const found: AssignedCard[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith("deskrpg-")) continue;
    const dbPath = path.join(root, name, "kanban.db");
    if (!fs.existsSync(dbPath)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare(
          "SELECT title, status, result FROM tasks WHERE assignee = ? AND status != 'archived'",
        )
        .all(profileName) as Array<{ title: string; status: string; result: string | null }>;
      for (const row of rows) {
        let file: string | null = null;
        if (!hideFiles) {
          for (const token of resultFileTokens(row.result)) {
            if (/My_Personal_DB|personal_data/i.test(token)) continue;
            const hit = resolveWorkFile(token, cwd);
            if (hit) {
              file = hit;
              break;
            }
          }
        }
        found.push({
          title: (row.title || "").replace(/\s+/g, " ").trim().slice(0, 160),
          status: row.status,
          file,
        });
      }
    } catch {
      continue;
    } finally {
      db?.close();
    }
  }
  found.sort((a, b) => STATUS_RANK.indexOf(a.status) - STATUS_RANK.indexOf(b.status));
  return found.slice(0, 8);
}

export function loadAssignedWork(
  profileName: string,
  locale: string | null | undefined = "ko",
): string {
  try {
    return formatAssignedWork(readCards(profileName), locale);
  } catch (err) {
    console.error("[assigned-work] failed for " + profileName, err);
    return formatAssignedWork([], locale);
  }
}
