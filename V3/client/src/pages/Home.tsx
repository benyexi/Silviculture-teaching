import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Streamdown } from "streamdown";
import { BookOpen, Search, Loader2, TreePine, GraduationCap, ExternalLink } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import type { QuerySource } from "@/types";

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: QuerySource[];
  queryId?: number;
};

type QuerySourceWithLocator = QuerySource & {
  fileUrl?: string | null;
};

type StreamMeta = {
  sources: QuerySource[];
  modelUsed: string;
  foundInMaterials: boolean;
  confidence: number;
  questionLanguage: "zh" | "en";
  queryId?: number;
  responseTimeMs?: number;
};

function normalizeAnswerMarkdown(text: string): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // 清除非标准引用格式，但保留 [1] [2] 等正规引用标记
    .replace(/\[引用\d+\]/g, "")
    .replace(/\[citation_indices?:\s*[\d,\s]+\]/gi, "")
    .replace(/【?片段\d+】?/g, "")
    .replace(/片段\[?\d+\]?至?\[?\d*\]?/g, "")
    // 标准化引用格式
    .replace(/\[\s*(\d+)\s*\]/g, "[$1]")
    .replace(/([^\n])\s+(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/([^\n])\s+((?:[-*+]\s+|\d+\.\s+))/g, "$1\n\n$2")
    .replace(/\n[ \t]*([#>-])/g, "\n$1")
    .replace(/\n{1,2}([*-+]\s+)/g, "\n$1")
    .replace(/\n{1,2}(\d+\.\s+)/g, "\n$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createConversationId(): string {
  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export default function Home() {
  const { user } = useAuth();
  const { data: materials, isLoading: materialsLoading } = trpc.materials.list.useQuery();
  const [question, setQuestion] = useState("");
  const [activeQuestion, setActiveQuestion] = useState("");
  const [conversationHistory, setConversationHistory] = useState<ConversationMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>(() => createConversationId());
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState<boolean | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState<number | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const submitFeedback = trpc.qa.submitFeedback.useMutation();

  // 流式状态
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [streamAnswer, setStreamAnswer] = useState("");
  const [streamMeta, setStreamMeta] = useState<StreamMeta | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamStartTime, setStreamStartTime] = useState(0);
  const [streamElapsed, setStreamElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const publishedMaterials = (materials || []).filter((m) => m.status === "published");
  const selectedMaterial = publishedMaterials.find((m) => m.id === selectedMaterialId) || null;

  useEffect(() => {
    if (publishedMaterials.length === 0) {
      if (selectedMaterialId !== null) setSelectedMaterialId(null);
      return;
    }
    if (!selectedMaterial || selectedMaterialId === null) {
      setSelectedMaterialId(publishedMaterials[0].id);
    }
  }, [publishedMaterials, selectedMaterial, selectedMaterialId]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || isStreaming) return;
    if (!selectedMaterial) {
      setStreamError("请先选择一本已发布教材");
      return;
    }

    // 中断之前的请求
    if (abortRef.current) abortRef.current.abort();

    setActiveQuestion(q);
    setQuestion("");
    setStreamAnswer("");
    setStreamMeta(null);
    setStreamError(null);
    setIsSearching(true);
    setIsStreaming(true);
    setStreamStartTime(Date.now());
    setStreamElapsed(0);

    const controller = new AbortController();
    abortRef.current = controller;

    const historyPayload = conversationHistory.map(({ role, content }) => ({ role, content }));

    fetch("/api/stream/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: q,
        materialId: selectedMaterial.id,
        conversationId,
        history: historyPayload,
      }),
      signal: controller.signal,
    })
      .then(async (resp) => {
        if (!resp.ok) {
          const errBody = await resp.text();
          throw new Error(errBody || `HTTP ${resp.status}`);
        }

        const reader = resp.body?.getReader();
        if (!reader) throw new Error("No readable stream");

        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedAnswer = "";
        let currentMeta: StreamMeta | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let currentEvent = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7);
            } else if (line.startsWith("data: ")) {
              const data = line.slice(6);
              try {
                const parsed = JSON.parse(data);
                if (currentEvent === "meta") {
                  const meta = parsed as StreamMeta;
                  currentMeta = meta;
                  setStreamMeta(meta);
                  setIsSearching(false);
                } else if (currentEvent === "token") {
                  accumulatedAnswer += parsed.t;
                  setStreamAnswer(normalizeAnswerMarkdown(accumulatedAnswer));
                } else if (currentEvent === "done") {
                  if (typeof parsed?.answer === "string" && parsed.answer.length > 0) {
                    accumulatedAnswer = parsed.answer;
                    setStreamAnswer(normalizeAnswerMarkdown(parsed.answer));
                  }
                } else if (currentEvent === "error") {
                  setStreamError(parsed.message);
                }
              } catch {
                // ignore parse errors
              }
              currentEvent = "";
            }
          }
        }

        const finalAnswer = normalizeAnswerMarkdown(accumulatedAnswer).trim();
        if (finalAnswer) {
          setConversationHistory((prev) => [
            ...prev,
            { role: "user", content: q },
            {
              role: "assistant",
              content: finalAnswer,
              sources: currentMeta?.sources || [],
              queryId: currentMeta?.queryId,
            },
          ]);
        }

        setActiveQuestion("");
        setIsSearching(false);
        setIsStreaming(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setStreamError(err.message || "请求失败");
          setActiveQuestion("");
        }
        setIsStreaming(false);
        setIsSearching(false);
      });
  }, [question, isStreaming, selectedMaterial, conversationHistory, conversationId]);

  // 计时器：显示已用时间
  useEffect(() => {
    if (!isStreaming || !streamStartTime) return;
    const timer = setInterval(() => {
      setStreamElapsed(Date.now() - streamStartTime);
    }, 100);
    return () => clearInterval(timer);
  }, [isStreaming, streamStartTime]);

  const latestAssistantQueryId = [...conversationHistory].reverse().find((msg) => msg.role === "assistant")?.queryId;

  const handleFeedback = (helpful: boolean) => {
    const qid = latestAssistantQueryId || streamMeta?.queryId;
    if (!qid || feedbackSubmitted) return;
    submitFeedback.mutate({ queryId: qid, helpful });
    setFeedbackValue(helpful);
    setFeedbackSubmitted(true);
  };

  useEffect(() => {
    setFeedbackSubmitted(false);
    setFeedbackValue(null);
  }, [latestAssistantQueryId, streamMeta?.queryId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      handleSubmit(e as any);
    }
  };

  useEffect(() => {
    if (conversationHistory.length === 0 && !isStreaming) return;
    resultRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversationHistory.length, streamAnswer, isStreaming]);

  const handleNewConversation = () => {
    if (abortRef.current) abortRef.current.abort();
    setConversationHistory([]);
    setConversationId(createConversationId());
    setActiveQuestion("");
    setStreamAnswer("");
    setStreamMeta(null);
    setStreamError(null);
    setIsStreaming(false);
    setIsSearching(false);
    setStreamStartTime(0);
    setStreamElapsed(0);
    setFeedbackSubmitted(false);
    setFeedbackValue(null);
  };

  // 统一的结果显示状态
  const isPending = isStreaming && isSearching;
  const showResult = conversationHistory.length > 0 || isStreaming;

  // Forest background — place forest-bg.jpg in client/public/ or use a remote URL
  const FOREST_BG = "https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80";

  return (
    <div className="min-h-screen flex flex-col bg-[oklch(0.96_0.01_145)]">
      {/* 顶部导航 */}
      <header className="border-b border-white/20 bg-black/30 backdrop-blur-md sticky top-0 z-20">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <TreePine className="h-5 w-5 text-emerald-400" />
            <div>
              <span className="font-bold text-white text-base tracking-wide" style={{ fontFamily: "'Noto Serif SC', serif" }}>
                森林培育学
              </span>
              <span className="text-emerald-300/70 text-xs ml-2 font-light tracking-widest hidden sm:inline">SILVICULTURE INTELLIGENT Q&amp;A</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {user?.role === "admin" && (
              <a href="/teacher" className="text-xs text-emerald-300 hover:text-emerald-200 flex items-center gap-1.5 border border-emerald-500/40 rounded-full px-3 py-1 hover:border-emerald-400/60 transition-colors">
                <GraduationCap className="h-3.5 w-3.5" />
                Teacher Portal
              </a>
            )}
            {!user ? (
              <a href={getLoginUrl()} className="text-xs text-white/60 hover:text-white/90 tracking-wide">
                Sign In &nbsp;·&nbsp; 登录
              </a>
            ) : (
              <span className="text-xs text-white/70">{user.name}</span>
            )}
          </div>
        </div>
      </header>

      {/* Hero 区域：全宽森林背景 */}
      <section
        className="relative flex flex-col items-center justify-center px-4 py-16 md:py-24"
        style={{
          backgroundImage: `url('${FOREST_BG}')`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        {/* 半透明深绿遮罩，让文字和查询框清晰可见 */}
        <div className="absolute inset-0" style={{ background: "rgba(10, 40, 15, 0.52)" }} />

        <div className="relative z-10 w-full max-w-4xl mx-auto text-center">
          {/* 顶部小标签 */}
          <div className="inline-flex items-center gap-2 bg-emerald-500/20 border border-emerald-400/40 rounded-full px-4 py-1.5 mb-6 backdrop-blur-sm">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-emerald-200 text-xs font-medium tracking-widest uppercase">AI-Powered Knowledge System</span>
          </div>

          {/* 主标题：中英文双行 */}
          <h1 className="text-4xl md:text-6xl font-bold text-white mb-2 drop-shadow-lg" style={{ fontFamily: "'Noto Serif SC', serif" }}>
            森林培育学知识智能问答系统
          </h1>
          <div className="flex items-center justify-center gap-3 mb-6">
            <p className="text-emerald-300/80 text-sm md:text-base tracking-[0.25em] uppercase font-light">
              Silviculture Intelligent Q&amp;A System
            </p>
            <span className="text-xs font-mono text-emerald-400/70 border border-emerald-400/30 rounded px-1.5 py-0.5">V3.0</span>
          </div>
          <p className="text-white/80 text-sm md:text-base max-w-2xl mx-auto leading-relaxed mb-10 drop-shadow">
            Grounded in authoritative textbooks &middot; 严格基于教材内容回答 &middot; Every answer is fully cited
          </p>

          {/* 查询框 */}
          <form onSubmit={handleSubmit}>
            <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl border border-white/40 overflow-hidden">
              <div className="px-5 pt-4 pb-3 border-b border-border/30 bg-white/70">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <label htmlFor="material-select" className="text-xs font-medium text-foreground/80 tracking-wide">
                    选择提问教材
                  </label>
                  <span className="text-xs text-muted-foreground">
                    仅在当前教材内检索，不跨教材混合
                  </span>
                </div>
                <select
                  id="material-select"
                  className="mt-2 w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={selectedMaterialId ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSelectedMaterialId(v ? Number(v) : null);
                  }}
                  disabled={isStreaming || materialsLoading || publishedMaterials.length === 0}
                >
                  {materialsLoading && <option value="">教材加载中...</option>}
                  {!materialsLoading && publishedMaterials.length === 0 && (
                    <option value="">暂无已发布教材，请先上传并发布教材</option>
                  )}
                  {!materialsLoading &&
                    publishedMaterials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                      </option>
                    ))}
                </select>
              </div>
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question about silviculture — 例如：什么是立地质量？如何进行树种选择？造林密度如何确定？"
                className="min-h-[160px] md:min-h-[200px] text-base resize-none border-0 focus-visible:ring-0 p-5 bg-transparent text-foreground placeholder:text-muted-foreground/70 rounded-none"
                disabled={isStreaming || publishedMaterials.length === 0}
              />
              <div className="flex items-center justify-between px-5 py-4 border-t border-border/30 bg-white/60">
                <span className="text-xs text-muted-foreground">
                  Press Ctrl+Enter to submit &nbsp;·&nbsp; 按 Ctrl+Enter 快速提交
                </span>
                <Button
                  type="submit"
                  size="lg"
                  disabled={!question.trim() || isStreaming || !selectedMaterial}
                  className="gap-2 px-8 text-base"
                >
                  {isStreaming ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Searching...
                    </>
                  ) : (
                    <>
                      <Search className="h-5 w-5" />
                      Search &nbsp;·&nbsp; 查询
                    </>
                  )}
                </Button>
              </div>
            </div>
          </form>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="outline"
              className="bg-white/20 text-white border-white/40 hover:bg-white/30 hover:text-white"
              onClick={handleNewConversation}
              disabled={isStreaming && !streamError}
            >
              新对话
            </Button>
          </div>

          {/* 错误提示 */}
          {streamError && (
            <div className="mt-4 p-3 rounded-lg bg-red-900/60 text-red-200 text-sm backdrop-blur-sm">
              查询失败：{streamError}
            </div>
          )}
        </div>

        {/* 三个特性卡片 */}
        {!showResult && (
          <div className="relative z-10 w-full max-w-4xl mx-auto mt-10">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { en: "Semantic Retrieval", zh: "语义向量检索", desc: "基于语义向量检索，从教材中找到最相关的内容片段" },
                { en: "Fully Cited", zh: "来源可溯", desc: "每个答案都标注教材名称、章节和页码，方便核对原文" },
                { en: "Textbook-Grounded", zh: "严格基于教材", desc: "系统约束 AI 严格基于教材内容回答，减少自由发挥" },
              ].map((item) => (
                <div key={item.en} className="bg-white/15 backdrop-blur-sm rounded-xl p-4 border border-white/25 text-left">
                  <p className="text-emerald-300 text-xs font-semibold tracking-widest uppercase mb-0.5">{item.en}</p>
                  <h3 className="font-semibold text-sm text-white mb-1">{item.zh}</h3>
                  <p className="text-xs text-white/70 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 答案展示区（白色背景，在森林图下方） */}
      {showResult && (
        <main className="flex-1 bg-[oklch(0.97_0.008_145)] py-8">
          <div className="container">
            <div ref={resultRef} className="max-w-4xl mx-auto space-y-4">
              {conversationHistory.map((message, idx) => {
                if (message.role === "user") {
                  return (
                    <div key={`user-${idx}`} className="flex justify-end">
                      <div className="max-w-[90%] md:max-w-[80%] rounded-2xl bg-blue-600 text-white px-4 py-3 shadow-sm">
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
                      </div>
                    </div>
                  );
                }

                const sources = message.sources || [];
                const linkedQuestion = [...conversationHistory.slice(0, idx)]
                  .reverse()
                  .find((m) => m.role === "user")?.content || "";
                const sourceIdPrefix = `turn-${idx}`;

                return (
                  <div key={`assistant-${idx}`} className="space-y-3">
                    <div className="flex justify-start">
                      <Card className="w-full max-w-[95%] md:max-w-[88%] bg-white shadow-sm">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-base flex items-center gap-2">
                            <BookOpen className="h-4 w-4 text-primary" />
                            AI 回答
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <div className="notebook-answer">
                            <CitedAnswer
                              answer={message.content}
                              sourceCount={sources.length}
                              sourceIdPrefix={sourceIdPrefix}
                            />
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    {sources.length > 0 ? (
                      <details className="pl-0 md:pl-2 group">
                        <summary className="list-none cursor-pointer select-none inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60">
                          <span>引用来源（{sources.length}）</span>
                          <span className="text-primary group-open:hidden">展开</span>
                          <span className="text-primary hidden group-open:inline">收起</span>
                        </summary>
                        <div className="mt-2 space-y-3">
                          {sources.map((source, sourceIdx) => (
                            <SourceCard
                              key={`${sourceIdPrefix}-${sourceIdx}`}
                              source={source}
                              index={sourceIdx + 1}
                              idPrefix={sourceIdPrefix}
                            />
                          ))}
                        </div>
                      </details>
                    ) : (
                      <div className="text-xs text-muted-foreground pl-1">该回答未返回可引用教材来源。</div>
                    )}
                  </div>
                );
              })}

              {isStreaming && activeQuestion && (
                <div className="flex justify-end">
                  <div className="max-w-[90%] md:max-w-[80%] rounded-2xl bg-blue-600 text-white px-4 py-3 shadow-sm">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{activeQuestion}</p>
                  </div>
                </div>
              )}

              {isStreaming && (
                <div className="space-y-3">
                  <div className="flex justify-start">
                    <Card className="w-full max-w-[95%] md:max-w-[88%] bg-white shadow-sm">
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-base flex items-center gap-2">
                            <BookOpen className="h-4 w-4 text-primary" />
                            AI 回答
                            <Loader2 className="h-4 w-4 animate-spin text-primary ml-1" />
                          </CardTitle>
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            {(streamElapsed / 1000).toFixed(1)}s
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0">
                        {isPending && !streamAnswer && (
                          <div className="text-sm text-muted-foreground flex items-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            正在检索教材并生成答案...
                          </div>
                        )}
                        {streamAnswer && (
                          <div className="notebook-answer">
                            <CitedAnswer
                              answer={streamAnswer}
                              sourceCount={streamMeta?.sources?.length || 0}
                              sourceIdPrefix="streaming"
                            />
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  {(streamMeta?.sources?.length || 0) > 0 && (
                    <details className="pl-0 md:pl-2 group">
                      <summary className="list-none cursor-pointer select-none inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60">
                        <span>引用来源（{streamMeta?.sources?.length || 0}）</span>
                        <span className="text-primary group-open:hidden">展开</span>
                        <span className="text-primary hidden group-open:inline">收起</span>
                      </summary>
                      <div className="mt-2 space-y-3">
                        {(streamMeta?.sources || []).map((source, sourceIdx) => (
                          <SourceCard
                            key={`streaming-${sourceIdx}`}
                            source={source}
                            index={sourceIdx + 1}
                            idPrefix="streaming"
                          />
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {!isStreaming && latestAssistantQueryId && (
                <Card className="shadow-sm">
                  <CardContent className="pt-5 pb-5">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm text-muted-foreground">这个答案对你有帮助吗？</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleFeedback(true)}
                        disabled={feedbackSubmitted}
                        className={feedbackSubmitted && feedbackValue === true ? "border-green-500 text-green-600" : ""}
                      >
                        👍 有帮助
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleFeedback(false)}
                        disabled={feedbackSubmitted}
                        className={feedbackSubmitted && feedbackValue === false ? "border-red-400 text-red-500" : ""}
                      >
                        👎 没帮助
                      </Button>
                      {feedbackSubmitted && (
                        <span className="text-sm text-muted-foreground">感谢反馈！</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </main>
      )}

      {/* 无结果时撑开空间 */}
      {!showResult && <div className="flex-1" />}

      {/* 底部版权 */}
      <footer className="border-t border-border/40 py-5 bg-white/90">
        <div className="container text-center space-y-1">
          <p className="text-xs text-muted-foreground/60 tracking-widest uppercase">
            Beijing Forestry University &nbsp;&middot;&nbsp; Silviculture Discipline
          </p>
          <p className="text-sm text-muted-foreground">
            本系统由北京林业大学森林培育学科席本野开发
          </p>
        </div>
      </footer>
    </div>
  );
}

// ─── NotebookLM 风格引用标注答案 ──────────────────────────────────────────────
function CitedAnswer({
  answer,
  sourceCount,
  sourceIdPrefix = "default",
}: {
  answer: string;
  sourceCount: number;
  sourceIdPrefix?: string;
}) {
  // 将 [1] [2] 等引用标记渲染为可点击的角标
  const processedAnswer = answer.replace(
    /\[(\d+)\]/g,
    (match, num) => {
      const n = parseInt(num, 10);
      if (n >= 1 && n <= sourceCount) {
        return `<cite-ref data-idx="${n}">[${n}]</cite-ref>`;
      }
      return match;
    }
  );

  // 使用 Streamdown 渲染 markdown，然后后处理 cite-ref 标签
  return (
    <div
      className="cited-answer"
      ref={(el) => {
        if (!el) return;
        // 将 <cite-ref> 转换为可点击的角标
        const refs = el.querySelectorAll("cite-ref");
        refs.forEach((ref) => {
          if (ref.getAttribute("data-processed")) return;
          ref.setAttribute("data-processed", "1");
          const idx = ref.getAttribute("data-idx");
          if (!idx) return;
          const badge = document.createElement("sup");
          badge.className = "cite-badge";
          badge.textContent = idx;
          badge.title = `查看来源 ${idx}`;
          badge.onclick = () => {
            const target = document.getElementById(`${sourceIdPrefix}-source-${idx}`);
            if (target) {
              const collapsible = target.closest("details");
              if (collapsible && !(collapsible as HTMLDetailsElement).open) (collapsible as HTMLDetailsElement).open = true;
              target.scrollIntoView({ behavior: "smooth", block: "center" });
              target.classList.add("ring-2", "ring-primary", "ring-offset-2");
              setTimeout(() => target.classList.remove("ring-2", "ring-primary", "ring-offset-2"), 2000);
            }
          };
          ref.replaceWith(badge);
        });
      }}
    >
      <Streamdown>{processedAnswer}</Streamdown>
    </div>
  );
}

// ─── 引用来源卡片组件 ─────────────────────────────────────────────────────────
function SourceCard({
  source,
  index,
  idPrefix = "default",
}: {
  source: QuerySourceWithLocator;
  index: number;
  idPrefix?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const pageLabel = source.pageStart
    ? `第${source.pageStart}${source.pageEnd && source.pageEnd !== source.pageStart ? `-${source.pageEnd}` : ""}页`
    : "页码未标注";
  const chapterLabel = source.chapter || "章节未标注";
  const excerptText = source.excerpt || source.highlightedExcerpt || "";
  const canLocate = Boolean(source.fileUrl);
  const locateUrl = canLocate
    ? source.pageStart
      ? `${String(source.fileUrl).split("#")[0]}#page=${source.pageStart}`
      : String(source.fileUrl)
    : null;
  const openLocate = () => {
    if (!locateUrl) return;
    window.open(locateUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      id={`${idPrefix}-source-${index}`}
      className={`border-l-4 border-primary/50 bg-primary/5 rounded-r-lg p-3 transition-all duration-300 ${canLocate ? "cursor-pointer hover:bg-primary/10" : ""}`}
      onClick={canLocate ? openLocate : undefined}
      role={canLocate ? "button" : undefined}
      tabIndex={canLocate ? 0 : undefined}
      onKeyDown={canLocate ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLocate(); } } : undefined}
      title={canLocate ? "点击定位到教材原文" : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
              {index}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {source.materialTitle} · {chapterLabel} · {pageLabel}
            </span>
            {canLocate && <ExternalLink className="h-3.5 w-3.5 text-primary/80 shrink-0" aria-label="可定位来源" />}
          </div>
          <p className={`text-xs text-foreground/80 leading-relaxed ${!expanded ? "line-clamp-2" : ""}`}>
            {renderSourceExcerpt(excerptText, source.highlightedExcerpt)}
          </p>
        </div>
      </div>
      {excerptText.length > 100 && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="mt-1 text-xs text-primary hover:underline"
        >
          {expanded ? "收起" : "展开原文"}
        </button>
      )}
    </div>
  );
}

function renderSourceExcerpt(excerpt: string, highlightedExcerpt?: string): React.ReactNode {
  const needle = highlightedExcerpt?.trim();
  if (!needle || !excerpt) return excerpt;
  const lowerExcerpt = excerpt.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < excerpt.length) {
    const foundAt = lowerExcerpt.indexOf(lowerNeedle, cursor);
    if (foundAt === -1) { nodes.push(excerpt.slice(cursor)); break; }
    if (foundAt > cursor) nodes.push(excerpt.slice(cursor, foundAt));
    nodes.push(<mark key={`sm-${key++}`} className="bg-yellow-200 text-yellow-900 rounded px-0.5">{excerpt.slice(foundAt, foundAt + needle.length)}</mark>);
    cursor = foundAt + needle.length;
  }
  return nodes;
}
