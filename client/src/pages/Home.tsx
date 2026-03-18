import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Streamdown } from "streamdown";
import { BookOpen, Search, Loader2, ChevronDown, ChevronUp, TreePine, GraduationCap } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import type { QuerySource } from "@/types";

type AnswerResult = {
  answer: string;
  sources: QuerySource[];
  modelUsed: string;
  responseTimeMs: number;
  queryId: number;
  foundInMaterials: boolean;
  questionLanguage: "zh" | "en";
  enAnswer?: string;
  enSources?: QuerySource[];
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
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\[引用\d+\]/g, "")
    .replace(/\[citation_indices?:\s*[\d,\s]+\]/gi, "")
    .replace(/【?片段\d+】?/g, "")
    .replace(/片段\[?\d+\]?至?\[?\d*\]?/g, "")
    .replace(/([^\n])\s+(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/\n[ \t]*([#>-])/g, "\n$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function Home() {
  const { user } = useAuth();
  const [question, setQuestion] = useState("");
  const [askedQuestion, setAskedQuestion] = useState("");
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [showSources, setShowSources] = useState(true);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState<boolean | null>(null);
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

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || isStreaming) return;

    // 中断之前的请求
    if (abortRef.current) abortRef.current.abort();

    setAskedQuestion(q);
    setResult(null);
    setStreamAnswer("");
    setStreamMeta(null);
    setStreamError(null);
    setIsSearching(true);
    setIsStreaming(true);
    setStreamStartTime(Date.now());
    setStreamElapsed(0);

    const controller = new AbortController();
    abortRef.current = controller;

    fetch("/api/stream/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
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
                  setStreamMeta(parsed as StreamMeta);
                  setIsSearching(false);
                  setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
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

        setIsStreaming(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setStreamError(err.message || "请求失败");
        }
        setIsStreaming(false);
        setIsSearching(false);
      });
  }, [question, isStreaming]);

  // 计时器：显示已用时间
  useEffect(() => {
    if (!isStreaming || !streamStartTime) return;
    const timer = setInterval(() => {
      setStreamElapsed(Date.now() - streamStartTime);
    }, 100);
    return () => clearInterval(timer);
  }, [isStreaming, streamStartTime]);

  const handleFeedback = (helpful: boolean) => {
    const qid = result?.queryId || streamMeta?.queryId;
    if (!qid || feedbackSubmitted) return;
    submitFeedback.mutate({ queryId: qid, helpful });
    setFeedbackValue(helpful);
    setFeedbackSubmitted(true);
  };

  useEffect(() => {
    setFeedbackSubmitted(false);
    setFeedbackValue(null);
  }, [result?.queryId, streamMeta?.queryId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      handleSubmit(e as any);
    }
  };

  // 统一的结果显示状态
  const isPending = isStreaming && isSearching;
  const hasAnswer = streamAnswer.length > 0 || result?.answer;
  const displayAnswer = streamAnswer || result?.answer || "";
  const displaySources = streamMeta?.sources || result?.sources || [];
  const displayTime = streamMeta?.responseTimeMs || (streamElapsed > 0 ? streamElapsed : result?.responseTimeMs || 0);
  const displayFoundInMaterials = streamMeta?.foundInMaterials ?? result?.foundInMaterials ?? true;
  const showResult = hasAnswer || isPending || isStreaming;

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
            <span className="text-xs font-mono text-emerald-400/70 border border-emerald-400/30 rounded px-1.5 py-0.5">V1.0</span>
          </div>
          <p className="text-white/80 text-sm md:text-base max-w-2xl mx-auto leading-relaxed mb-10 drop-shadow">
            Grounded in authoritative textbooks &middot; 严格基于教材内容回答 &middot; Every answer is fully cited
          </p>

          {/* 查询框 */}
          <form onSubmit={handleSubmit}>
            <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl border border-white/40 overflow-hidden">
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question about silviculture — 例如：什么是立地质量？如何进行树种选择？造林密度如何确定？"
                className="min-h-[160px] md:min-h-[200px] text-base resize-none border-0 focus-visible:ring-0 p-5 bg-transparent text-foreground placeholder:text-muted-foreground/70 rounded-none"
                disabled={isStreaming}
              />
              <div className="flex items-center justify-between px-5 py-4 border-t border-border/30 bg-white/60">
                <span className="text-xs text-muted-foreground">
                  Press Ctrl+Enter to submit &nbsp;·&nbsp; 按 Ctrl+Enter 快速提交
                </span>
                <Button
                  type="submit"
                  size="lg"
                  disabled={!question.trim() || isStreaming}
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
              {isPending && (
                <div className="text-center py-12 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-primary" />
                  <p>正在检索教材并生成答案，请稍候...</p>
                </div>
              )}

              {(hasAnswer || (isStreaming && !isSearching)) && (
                <>
                  {/* 主答案 */}
                  <Card className="shadow-sm">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <BookOpen className="h-5 w-5 text-primary" />
                          Answer &nbsp;<span className="text-muted-foreground font-normal text-base">教材答案</span>
                          {isStreaming && (
                            <Loader2 className="h-4 w-4 animate-spin text-primary ml-1" />
                          )}
                        </CardTitle>
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          {(displayTime / 1000).toFixed(1)}s
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="prose prose-sm max-w-none text-foreground leading-relaxed">
                        <Streamdown>{displayAnswer}</Streamdown>
                      </div>

                      {!isStreaming && displayFoundInMaterials && (
                        <div className="mt-4 pt-3 border-t border-border flex items-center gap-3 flex-wrap">
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
                      )}
                    </CardContent>
                  </Card>

                  {/* 引用来源 */}
                  {displaySources.length > 0 && (
                    <Card className="shadow-sm">
                      <CardHeader className="pb-2 cursor-pointer" onClick={() => setShowSources(!showSources)}>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold">
                              {displaySources.length}
                            </span>
                            Sources &nbsp;&middot;&nbsp; 引用教材来源
                          </CardTitle>
                          {showSources ? (
                            <ChevronUp className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                      </CardHeader>
                      {showSources && (
                        <CardContent className="pt-0 space-y-3">
                          {displaySources.map((source, idx) => (
                            <SourceCard
                              key={idx}
                              source={source}
                              index={idx + 1}
                              keywords={extractHighlightKeywords(askedQuestion)}
                            />
                          ))}
                        </CardContent>
                      )}
                    </Card>
                  )}

                  {/* 无来源提示 */}
                  {!isStreaming && displaySources.length === 0 && (
                    <div className="text-center py-4 text-sm text-muted-foreground">
                      本次回答未能匹配到具体教材片段，建议换一种问法或咨询教师。
                    </div>
                  )}
                </>
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

// ─── 引用来源卡片组件 ─────────────────────────────────────────────────────────
function SourceCard({
  source,
  index,
  keywords,
}: {
  source: QuerySource;
  index: number;
  keywords: string[];
}) {
  const [expanded, setExpanded] = useState(false);

  const pageLabel = source.pageStart
    ? `第 ${source.pageStart}${source.pageEnd && source.pageEnd !== source.pageStart ? `–${source.pageEnd}` : ""} 页`
    : null;
  const chapterPath = source.chapter
    ? pageLabel
      ? `${source.chapter} > ${pageLabel}`
      : source.chapter
    : pageLabel || "未标注章节";

  return (
    <div className="border-l-4 border-primary/50 bg-primary/5 rounded-r-lg p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
              {index}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {source.materialTitle} · {chapterPath}
            </span>
          </div>
          <p className={`text-xs text-foreground/80 leading-relaxed ${!expanded ? "line-clamp-2" : ""}`}>
            {highlightKeywords(source.highlightedExcerpt || source.excerpt, keywords)}
          </p>
        </div>
      </div>
      {(source.highlightedExcerpt || source.excerpt) && (source.highlightedExcerpt || source.excerpt).length > 100 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-primary hover:underline"
        >
          {expanded ? "收起" : "展开原文"}
        </button>
      )}
    </div>
  );
}

function extractHighlightKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[，。！？；、,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2)
    )
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightKeywords(text: string, keywords: string[]): React.ReactNode {
  if (!keywords.length) return text;
  const pattern = new RegExp(`(${keywords.map((k) => escapeRegExp(k)).join("|")})`, "g");
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    keywords.includes(part) ? (
      <mark key={i} className="bg-yellow-200 text-yellow-900 rounded px-0.5">
        {part}
      </mark>
    ) : (
      part
    )
  );
}
