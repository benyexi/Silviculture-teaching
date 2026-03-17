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

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "linear-gradient(135deg, oklch(0.96 0.01 145) 0%, oklch(0.98 0.005 145) 100%)" }}>
      {/* 顶部导航 */}
      <header className="border-b border-border/60 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-2">
            <TreePine className="h-6 w-6 text-primary" />
            <span className="font-semibold text-foreground text-lg" style={{ fontFamily: "'Noto Serif SC', serif" }}>
              森林培育学智能问答
            </span>
          </div>
          <div className="flex items-center gap-3">
            {user?.role === "admin" && (
              <a href="/teacher" className="text-sm text-primary hover:underline flex items-center gap-1">
                <GraduationCap className="h-4 w-4" />
                教师后台
              </a>
            )}
            {!user ? (
              <a href={getLoginUrl()} className="text-sm text-muted-foreground hover:text-foreground">
                教师登录
              </a>
            ) : (
              <span className="text-sm text-muted-foreground">{user.name}</span>
            )}
          </div>
        </div>
      </header>

      {/* 主体内容 */}
      <main className="flex-1 container py-8 md:py-12">
        {/* Hero 区域 */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-4">
            <BookOpen className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
            森林培育学教材问答系统
          </h1>
          <p className="text-muted-foreground text-base md:text-lg max-w-2xl mx-auto leading-relaxed">
            基于教材内容的智能问答，所有答案严格来源于上传的教材，并标注引用出处。
            输入您的问题，获取精准的教材知识。
          </p>
        </div>

        {/* 搜索框 */}
        <div className="max-w-3xl mx-auto mb-8">
          <form onSubmit={handleSubmit}>
            <Card className="shadow-md border-border/80">
              <CardContent className="p-4">
                <Textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="请输入您的森林培育学问题，例如：什么是立地质量？如何进行树种选择？"
                  className="min-h-[100px] text-base resize-none border-0 focus-visible:ring-0 p-0 bg-transparent"
                  disabled={askMutation.isPending}
                />
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/40">
                  <span className="text-xs text-muted-foreground">
                    按 Ctrl+Enter 快速提交
                  </span>
                  <Button
                    type="submit"
                    disabled={!question.trim() || askMutation.isPending}
                    className="gap-2"
                  >
                    {askMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在检索教材...
                      </>
                    ) : (
                      <>
                        <Search className="h-4 w-4" />
                        查询教材
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </form>

          {/* 错误提示 */}
          {askMutation.isError && (
            <div className="mt-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              查询失败：{askMutation.error?.message || "请稍后重试"}
            </div>
          )}
        </div>

        {/* 答案展示 */}
        {result && (
          <div ref={resultRef} className="max-w-3xl mx-auto space-y-4">
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
          </div>
        )}

        {/* 使用提示（无结果时显示） */}
        {!result && !askMutation.isPending && (
          <div className="max-w-3xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { title: "精准检索", desc: "基于语义向量检索，从教材中找到最相关的内容片段" },
                { title: "来源可溯", desc: "每个答案都标注教材名称、章节和页码，方便核对原文" },
                { title: "严格基于教材", desc: "系统约束 AI 严格基于教材内容回答，减少自由发挥" },
              ].map((item) => (
                <Card key={item.title} className="border-border/60 bg-white/60">
                  <CardContent className="p-4">
                    <h3 className="font-semibold text-sm text-foreground mb-1">{item.title}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* 底部版权 */}
      <footer className="border-t border-border/40 py-4 bg-white/60">
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
