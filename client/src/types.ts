// 前端类型定义

export type QuerySource = {
  materialId: number;
  materialTitle: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  excerpt: string;
};

export type MaterialStatus = "uploading" | "processing" | "published" | "error";

export type LlmProvider = "openai" | "deepseek" | "qwen" | "ollama" | "custom";

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  qwen: "通义千问",
  ollama: "Ollama（本地）",
  custom: "自定义",
};

export const LLM_PROVIDER_DEFAULT_MODELS: Record<LlmProvider, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  qwen: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"],
  ollama: ["llama3.2", "qwen2.5", "deepseek-r1", "mistral"],
  custom: [],
};
