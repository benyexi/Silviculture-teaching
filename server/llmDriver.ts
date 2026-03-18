/**
 * LLM 驱动层 — 支持 OpenAI / DeepSeek / 通义千问 / Ollama / 自定义端点
 * 配置从数据库动态读取，修改后立即生效，无需重启服务。
 */
import OpenAI from "openai";
import { getDb } from "./db";
import { llmConfigs } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// ─── 类型定义 ─────────────────────────────────────────────────────────────────
export type LLMMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LLMResponse = {
  content: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
};

export type EmbeddingResponse = {
  embedding: number[];
  model: string;
};

// ─── 获取当前激活的 LLM 配置 ─────────────────────────────────────────────────
export async function getActiveLlmConfig() {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");

  const configs = await db
    .select()
    .from(llmConfigs)
    .where(eq(llmConfigs.isActive, true))
    .limit(1);

  if (configs.length === 0) {
    // 回退到内置 Forge API
    return null;
  }
  return configs[0];
}

// ─── 构建 OpenAI 兼容客户端 ───────────────────────────────────────────────────
function buildOpenAIClient(apiKey: string, baseURL?: string | null): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: baseURL || undefined,
  });
}

// ─── 获取各 Provider 的默认 Base URL ─────────────────────────────────────────
function getProviderBaseUrl(provider: string, customUrl?: string | null): string | undefined {
  if (customUrl) return customUrl;
  switch (provider) {
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "qwen":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    case "ollama":
      return "http://localhost:11434/v1";
    default:
      return undefined; // OpenAI 默认
  }
}

// ─── 主推理接口 ───────────────────────────────────────────────────────────────
export async function invokeLLMWithConfig(
  messages: LLMMessage[],
  systemPrompt?: string
): Promise<LLMResponse> {
  const config = await getActiveLlmConfig();

  if (!config) {
    throw new Error(
      "未配置 LLM 模型。请在教师端「模型配置」页面添加并激活一个 LLM 配置（支持 OpenAI / DeepSeek / 通义千问 / Ollama）。"
    );
  }

  const allMessages: LLMMessage[] = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }
  allMessages.push(...messages);

  const baseURL = getProviderBaseUrl(config.provider, config.apiBaseUrl);
  const apiKey = config.apiKey || "ollama"; // Ollama 不需要真实 key

  const client = buildOpenAIClient(apiKey, baseURL);

  const response = await client.chat.completions.create({
    model: config.modelName,
    messages: allMessages,
    temperature: config.temperature ?? 0.1,
    max_tokens: config.maxTokens ?? 4096,
  });

  const content = response.choices[0]?.message?.content || "";
  return {
    content,
    model: config.modelName,
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
  };
}

// ─── Embedding 接口 ───────────────────────────────────────────────────────────
export async function getEmbedding(text: string): Promise<number[]> {
  const config = await getActiveLlmConfig();

  // 优先使用配置中的 Embedding 设置
  if (config?.embeddingModel && config?.embeddingApiKey) {
    const baseURL = getProviderBaseUrl(config.provider, config.embeddingBaseUrl);
    const client = buildOpenAIClient(config.embeddingApiKey, baseURL);

    const response = await client.embeddings.create({
      model: config.embeddingModel,
      input: text,
    });
    return response.data[0].embedding;
  }

  throw new Error(
    "未配置 Embedding 模型。请在教师端「模型配置」页面配置 Embedding 模型和 API Key。"
  );
}

// ─── 余弦相似度计算 ───────────────────────────────────────────────────────────
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
