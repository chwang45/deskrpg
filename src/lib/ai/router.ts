import { spawn } from "node:child_process";
import { generateText, generateObject } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

// Groq API 설정 (완전 무료 티어)
const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

// 로컬 환경의 Ollama에 연결하기 위한 설정 (OpenAI 호환 API 사용)
// 2026-10-08: @ai-sdk/openai 4.0.83 에서 provider를 직접 호출하면
// (ollama("llama3.1:8b")) POST /v1/responses 로 간다. 같은 호출을
// http://127.0.0.1:11434 의 llama3.1:8b 에 보냈고 Ollama가 답을 돌려줬다.
// 로컬 워커는 이 Responses 경로를 유지한다. Groq 조율/빠른 워커는 바꾸지 않는다.
const ollama = createOpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
});

/**
 * 1. 모델 정의
 * - Smart (Orchestrator): GPT-OSS 120B (가장 강력한 무료 Groq 모델)
 * - Fast/Free (Worker): Qwen 3.8 27B (빠르고 한국어에 강한 다국어 모델)
 * - Local (Private): Ollama Llama3 (개인 정보 보호, 보안 데이터 처리)
 */
const models = {
  smart: groq("openai/gpt-oss-120b"),  // 지휘관: 120B 최강 모델 (무료)
  fast: groq("qwen/qwen3.8-27b"),      // 공짜 워커: 한국어 강점의 Qwen 27B (무료)
  local: ollama("llama3.1:8b"),        // 프라이빗 워커: 로컬 전용 (설치 확인됨)
};

/**
 * 작업 계획 스키마 정의 (지휘관 모델이 반환할 JSON 구조)
 */
const planSchema = z.object({
  subtasks: z.array(
    z.object({
      id: z.string().describe("작업의 고유 ID"),
      description: z.string().describe("해당 모델이 수행할 구체적인 작업 지시"),
      targetModel: z.enum(["fast", "local"]).describe(
        "개인정보/보안 데이터면 local, 단순한 인터넷 지식이나 텍스트 처리면 fast를 선택"
      ),
    })
  ),
  synthesisInstructions: z.string().describe("나중에 하위 작업 결과를 모아서 최종 답변을 만들 때 참고할 지침"),
});

export type MultiAgentTaskOptions = {
  abortSignal?: AbortSignal;
  /** Employee system instructions. Kept out of the user prompt so callers can pin that text. */
  instructions?: string;
};

export type MultiAgentTaskResult = {
  plan: z.infer<typeof planSchema>;
  workerResults: Array<{
    id: string;
    result: string;
    modelUsed: "fast" | "local";
    error?: unknown;
  }>;
  finalAnswer: string;
};

type MultiAgentRunner = (
  userPrompt: string,
  privateContext?: string,
  options?: MultiAgentTaskOptions,
) => Promise<MultiAgentTaskResult>;

let runnerOverride: MultiAgentRunner | null = null;

/** Tests substitute the live Groq/Ollama call. Production leaves this unset. */
export function setMultiAgentTaskRunner(runner: MultiAgentRunner | null) {
  runnerOverride = runner;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "DM cancelled");
}

const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";
const OLLAMA_START_SCRIPT = "D:\\AI_Projects\\Computer_Maintenance\\start_ollama_server.ps1";

async function ollamaTagsReachable(): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_TAGS_URL, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the workstation Ollama server only when a local worker is about to run. */
async function ensureLocalOllama(abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted || (await ollamaTagsReachable())) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", OLLAMA_START_SCRIPT],
      { windowsHide: true, stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 25000);
    const onAbort = () => {
      clearTimeout(timer);
      child.kill();
      finish();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("exit", () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      finish();
    });
    child.on("error", () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      finish();
    });
  });
}

/**
 * 멀티 에이전트 라우팅 메인 함수
 */
export async function executeMultiAgentTask(
  userPrompt: string,
  privateContext?: string,
  options?: MultiAgentTaskOptions,
): Promise<MultiAgentTaskResult> {
  if (runnerOverride) return runnerOverride(userPrompt, privateContext, options);
  const abortSignal = options?.abortSignal;
  const instructionBlock = options?.instructions ? `\n[직원 지시]\n${options.instructions}\n` : "";
  console.log("🚀 [Orchestrator] 작업 분석 및 분배 시작...");

  // 1. [지휘관] 작업 분해 및 계획 수립 (Task Breakdown)
  const { object: plan } = await generateObject({
    model: models.smart,
    schema: planSchema,
    abortSignal,
    prompt: `
      당신은 지휘관 에이전트입니다. 다음 사용자의 요청을 분석하여 하위 작업으로 나누고, 적절한 워커 모델에 할당하세요.
      ${instructionBlock}
      [사용자 요청]: ${userPrompt}
      
      [가용 워커 모델]
      - 'fast': 단순 리서치, 번역, 요약 등 일반적인 텍스트 처리 (무료 API)
      - 'local': 개인 정보나 로컬 파일(privateContext)을 읽고 처리해야 하는 보안 작업 (로컬 모델)
      
      ${privateContext ? `[주의: 다음 프라이빗 컨텍스트가 존재합니다. 이것과 관련된 작업은 반드시 'local'에 할당하세요]: ${privateContext}` : ""}
    `,
  });

  console.log("📋 [Orchestrator] 수립된 계획:", plan);

  if (plan.subtasks.some((task) => task.targetModel === "local")) {
    if (abortSignal?.aborted) throw Object.assign(new Error("DM cancelled"), { name: "AbortError" });
    await ensureLocalOllama(abortSignal);
    if (abortSignal?.aborted) throw Object.assign(new Error("DM cancelled"), { name: "AbortError" });
  }

  // 2. [워커] 병렬 작업 실행 (Parallel Execution)
  console.log("⚡ [Workers] 하위 작업 병렬 실행 시작...");
  const executionPromises = plan.subtasks.map(async (task) => {
    const workerModel = models[task.targetModel];
    
    // 로컬 모델일 경우에만 privateContext를 포함하여 프롬프트 작성
    const workerPrompt = task.targetModel === "local" && privateContext
      ? `[Private Data]:\n${privateContext}\n\n[Task]:\n${task.description}`
      : `[Task]:\n${task.description}`;

    try {
      const { text } = await generateText({
        model: workerModel,
        abortSignal,
        prompt: workerPrompt,
      });
      return { id: task.id, result: text, modelUsed: task.targetModel };
    } catch (error) {
      if (isAbortError(error) || abortSignal?.aborted) throw error;
      console.error(`❌ [Worker ${task.id}] 에러 발생:`, error);
      return { id: task.id, result: "작업 실패", modelUsed: task.targetModel, error };
    }
  });

  const workerResults = await Promise.all(executionPromises);
  console.log("✅ [Workers] 병렬 작업 완료:", workerResults);

  // 3. [지휘관] 결과 취합 (Synthesis)
  console.log("🧠 [Orchestrator] 최종 결과 취합 중...");
  if (abortSignal?.aborted) throw Object.assign(new Error("DM cancelled"), { name: "AbortError" });
  const { text: finalAnswer } = await generateText({
    model: models.smart,
    abortSignal,
    prompt: `
      당신은 지휘관 에이전트입니다. 당신이 수립했던 취합 지침과 워커들이 병렬로 수행한 결과물을 바탕으로 최종 답변을 작성하세요.
      ${instructionBlock}
      [사용자 요청]: ${userPrompt}
      
      [최종 취합 지침]: ${plan.synthesisInstructions}

      [워커 결과물]:
      ${JSON.stringify(workerResults, null, 2)}
      
      최종 답변:
    `,
  });

  console.log("🎉 [완료] 최종 답변 생성됨.");
  
  return {
    plan,
    workerResults,
    finalAnswer
  };
}
