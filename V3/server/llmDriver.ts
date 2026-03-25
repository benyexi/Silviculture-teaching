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

export type LLMInvokeOptions = {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json_object";
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
  systemPrompt?: string,
  options?: LLMInvokeOptions
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

  const responseFormat =
    options?.responseFormat === "json_object"
      ? { type: "json_object" as const }
      : undefined;

  const response = await client.chat.completions.create({
    model: config.modelName,
    messages: allMessages,
    temperature: options?.temperature ?? config.temperature ?? 0.1,
    max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });

  const content = response.choices[0]?.message?.content || "";
  return {
    content,
    model: config.modelName,
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
  };
}

// ─── 流式推理接口 ─────────────────────────────────────────────────────────────
export async function invokeLLMStreamWithConfig(
  messages: LLMMessage[],
  systemPrompt?: string,
  options?: LLMInvokeOptions
): Promise<{ stream: AsyncIterable<string>; model: string }> {
  const config = await getActiveLlmConfig();

  if (!config) {
    throw new Error(
      "未配置 LLM 模型。请在教师端「模型配置」页面添加并激活一个 LLM 配置。"
    );
  }

  const allMessages: LLMMessage[] = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }
  allMessages.push(...messages);

  const baseURL = getProviderBaseUrl(config.provider, config.apiBaseUrl);
  const apiKey = config.apiKey || "ollama";
  const client = buildOpenAIClient(apiKey, baseURL);

  const responseFormat =
    options?.responseFormat === "json_object"
      ? { type: "json_object" as const }
      : undefined;

  const response = await client.chat.completions.create({
    model: config.modelName,
    messages: allMessages,
    temperature: options?.temperature ?? config.temperature ?? 0.1,
    max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    stream: true,
  });

  async function* textStream() {
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  return { stream: textStream(), model: config.modelName };
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

/** 批量 Embedding（用于大文档导入阶段降本增效） */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const config = await getActiveLlmConfig();
  if (config?.embeddingModel && config?.embeddingApiKey) {
    const baseURL = getProviderBaseUrl(config.provider, config.embeddingBaseUrl);
    const client = buildOpenAIClient(config.embeddingApiKey, baseURL);

    const response = await client.embeddings.create({
      model: config.embeddingModel,
      input: texts,
    });

    const ordered = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);

    if (ordered.length !== texts.length) {
      throw new Error(`批量 Embedding 返回数量异常：expected=${texts.length}, actual=${ordered.length}`);
    }
    return ordered;
  }

  throw new Error(
    "未配置 Embedding 模型。请在教师端「模型配置」页面配置 Embedding 模型和 API Key。"
  );
}

// ─── 测试连接 ─────────────────────────────────────────────────────────────────
export async function testLLMConnection(config: {
  provider: string;
  modelName: string;
  apiKey?: string | null;
  apiBaseUrl?: string | null;
}): Promise<{ success: boolean; message: string; latencyMs?: number }> {
  const baseURL = getProviderBaseUrl(config.provider, config.apiBaseUrl);
  const apiKey = config.apiKey?.trim() || (config.provider === "ollama" ? "ollama" : "");
  const client = buildOpenAIClient(apiKey, baseURL);

  const start = Date.now();
  try {
    const response = await client.chat.completions.create({
      model: config.modelName,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 5,
    });
    const latencyMs = Date.now() - start;
    const content = response.choices[0]?.message?.content || "";
    return { success: true, message: `连接成功！模型响应: "${content}" (${latencyMs}ms)`, latencyMs };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const msg = err?.message || String(err);
    // 提取关键错误信息
    if (msg.includes("401") || msg.includes("Authentication") || msg.includes("invalid")) {
      return { success: false, message: `API Key 无效。请检查 Key 是否正确、是否已过期、账户是否有余额。\n原始错误: ${msg}` };
    }
    if (msg.includes("404")) {
      return { success: false, message: `模型 "${config.modelName}" 不存在或 Base URL 不正确。\n原始错误: ${msg}` };
    }
    if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
      return { success: false, message: `无法连接到 API 服务器。请检查 Base URL 是否正确。\n原始错误: ${msg}` };
    }
    return { success: false, message: `连接失败: ${msg}` };
  }
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
