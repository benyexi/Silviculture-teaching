import { useState, useRef } from "react";
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
};

export default function Home() {
  const { user } = useAuth();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [showSources, setShowSources] = useState(true);
  const resultRef = useRef<HTMLDivElement>(null);

  const askMutation = trpc.qa.ask.useMutation({
    onSuccess: (data) => {
      setResult(data as AnswerResult);
      setShowSources(true);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || askMutation.isPending) return;
    setResult(null);
    askMutation.mutate({ question: question.trim() });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      handleSubmit(e as any);
    }
  };

  const FOREST_BG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663401618844/UwcsU6Nu9y4z2Keggtu7BV/forest-bg_f271853a.jpg";

  return (
    <div className="min-h-screen flex flex-col bg-[oklch(0.96_0.01_145)]">
      {/* 顶部导航 */}
      <header className="border-b border-white/20 bg-black/30 backdrop-blur-md sticky top-0 z-20">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-2">
            <TreePine className="h-6 w-6 text-emerald-300" />
            <span className="font-semibold text-white text-lg" style={{ fontFamily: "'Noto Serif SC', serif" }}>
              森林培育学智能问答
            </span>
          </div>
          <div className="flex items-center gap-3">
            {user?.role === "admin" && (
              <a href="/teacher" className="text-sm text-emerald-300 hover:text-emerald-200 flex items-center gap-1">
                <GraduationCap className="h-4 w-4" />
                教师后台
              </a>
            )}
            {!user ? (
              <a href={getLoginUrl()} className="text-sm text-white/70 hover:text-white">
                教师登录
              </a>
            ) : (
              <span className="text-sm text-white/80">{user.name}</span>
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
          {/* 标题 */}
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/15 backdrop-blur-sm mb-5 border border-white/25">
            <BookOpen className="h-8 w-8 text-emerald-200" />
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-white mb-4 drop-shadow-lg" style={{ fontFamily: "'Noto Serif SC', serif" }}>
            森林培育学教材问答系统
          </h1>
          <p className="text-white/85 text-base md:text-lg max-w-2xl mx-auto leading-relaxed mb-10 drop-shadow">
            基于教材内容的智能问答，所有答案严格来源于上传的教材，并标注引用出处。
            输入您的问题，获取精准的教材知识。
          </p>

          {/* 查询框 */}
          <form onSubmit={handleSubmit}>
            <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl border border-white/40 overflow-hidden">
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="请输入您的森林培育学问题，例如：什么是立地质量？如何进行树种选择？造林密度如何确定？"
                className="min-h-[160px] md:min-h-[200px] text-base resize-none border-0 focus-visible:ring-0 p-5 bg-transparent text-foreground placeholder:text-muted-foreground/70 rounded-none"
                disabled={askMutation.isPending}
              />
              <div className="flex items-center justify-between px-5 py-4 border-t border-border/30 bg-white/60">
                <span className="text-xs text-muted-foreground">
                  按 Ctrl+Enter 快速提交
                </span>
                <Button
                  type="submit"
                  size="lg"
                  disabled={!question.trim() || askMutation.isPending}
                  className="gap-2 px-8 text-base"
                >
                  {askMutation.isPending ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      正在检索教材...
                    </>
                  ) : (
                    <>
                      <Search className="h-5 w-5" />
                      查询教材
                    </>
                  )}
                </Button>
              </div>
            </div>
          </form>

          {/* 错误提示 */}
          {askMutation.isError && (
            <div className="mt-4 p-3 rounded-lg bg-red-900/60 text-red-200 text-sm backdrop-blur-sm">
              查询失败：{askMutation.error?.message || "请稍后重试"}
            </div>
          )}
        </div>

        {/* 三个特性卡片 */}
        {!result && !askMutation.isPending && (
          <div className="relative z-10 w-full max-w-4xl mx-auto mt-10">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { title: "精准检索", desc: "基于语义向量检索，从教材中找到最相关的内容片段" },
                { title: "来源可溯", desc: "每个答案都标注教材名称、章节和页码，方便核对原文" },
                { title: "严格基于教材", desc: "系统约束 AI 严格基于教材内容回答，减少自由发挥" },
              ].map((item) => (
                <div key={item.title} className="bg-white/15 backdrop-blur-sm rounded-xl p-4 border border-white/25 text-left">
                  <h3 className="font-semibold text-sm text-white mb-1">{item.title}</h3>
                  <p className="text-xs text-white/75 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 答案展示区（白色背景，在森林图下方） */}
      {(result || askMutation.isPending) && (
        <main className="flex-1 bg-[oklch(0.97_0.008_145)] py-8">
          <div className="container">
            <div ref={resultRef} className="max-w-4xl mx-auto space-y-4">
              {askMutation.isPending && (
                <div className="text-center py-12 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-primary" />
                  <p>正在检索教材并生成答案，请稍候...</p>
                </div>
              )}

              {result && (
                <>
                  {/* 主答案 */}
                  <Card className="shadow-sm">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <BookOpen className="h-5 w-5 text-primary" />
                          教材答案
                        </CardTitle>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs">
                            {result.modelUsed}
                          </Badge>
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            {(result.responseTimeMs / 1000).toFixed(1)}s
                          </Badge>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="prose prose-sm max-w-none text-foreground leading-relaxed">
                        <Streamdown>{result.answer}</Streamdown>
                      </div>
                    </CardContent>
                  </Card>

                  {/* 引用来源 */}
                  {result.sources && result.sources.length > 0 && (
                    <Card className="shadow-sm">
                      <CardHeader className="pb-2 cursor-pointer" onClick={() => setShowSources(!showSources)}>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold">
                              {result.sources.length}
                            </span>
                            引用教材来源
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
                          {result.sources.map((source, idx) => (
                            <SourceCard key={idx} source={source} index={idx + 1} />
                          ))}
                        </CardContent>
                      )}
                    </Card>
                  )}

                  {/* 无来源提示 */}
                  {(!result.sources || result.sources.length === 0) && (
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
      {!result && !askMutation.isPending && <div className="flex-1" />}

      {/* 底部版权 */}
      <footer className="border-t border-border/40 py-4 bg-white/80">
        <div className="container text-center">
          <p className="text-sm text-muted-foreground">
            本系统由北京林业大学森林培育学科席本野开发
          </p>
        </div>
      </footer>
    </div>
  );
}

// ─── 引用来源卡片组件 ─────────────────────────────────────────────────────────
function SourceCard({ source, index }: { source: QuerySource; index: number }) {
  const [expanded, setExpanded] = useState(false);

  const locationParts = [
    source.materialTitle,
    source.chapter,
    source.pageStart ? `第 ${source.pageStart}${source.pageEnd && source.pageEnd !== source.pageStart ? `–${source.pageEnd}` : ""} 页` : null,
  ].filter(Boolean);

  return (
    <div className="border-l-4 border-primary/50 bg-primary/5 rounded-r-lg p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
              {index}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {locationParts.join(" · ")}
            </span>
          </div>
          <p className={`text-xs text-foreground/80 leading-relaxed ${!expanded ? "line-clamp-2" : ""}`}>
            {source.excerpt}
          </p>
        </div>
      </div>
      {source.excerpt && source.excerpt.length > 100 && (
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
