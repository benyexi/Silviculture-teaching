import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Streamdown } from "streamdown";
import { Search, MessageSquare, Clock, MapPin, BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import type { QuerySource } from "@/types";

export default function TeacherQueries() {
  const [limit, setLimit] = useState(50);
  const [search, setSearch] = useState("");
  const [selectedQuery, setSelectedQuery] = useState<any>(null);

  const { data: queries, isLoading } = trpc.stats.recentQueries.useQuery({ limit });

  const filtered = (queries || []).filter((q) =>
    !search || q.question.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">查询记录</h1>
        <p className="text-muted-foreground text-sm mt-1">查看学生的所有问答记录</p>
      </div>

      {/* 搜索和筛选 */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索问题关键词..."
            className="pl-9"
          />
        </div>
        <Button
          variant="outline"
          onClick={() => setLimit((l) => l + 50)}
          disabled={isLoading}
        >
          加载更多
        </Button>
      </div>

      {/* 统计信息 */}
      <div className="text-sm text-muted-foreground">
        共 {filtered.length} 条记录{search ? `（搜索"${search}"）` : ""}
      </div>

      {/* 查询列表 */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">加载中...</div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <MessageSquare className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
            <p className="text-muted-foreground">暂无查询记录</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((q) => (
            <Card
              key={q.id}
              className="hover:shadow-sm transition-shadow cursor-pointer"
              onClick={() => setSelectedQuery(q)}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="p-1.5 rounded-lg bg-primary/10 shrink-0 mt-0.5">
                    <MessageSquare className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-foreground line-clamp-2">{q.question}</p>
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {new Date(q.createdAt).toLocaleString("zh-CN")}
                      </span>
                      {q.visitorCity && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <MapPin className="h-3 w-3" />
                          {q.visitorCity}
                        </span>
                      )}
                      {q.responseTimeMs && (
                        <span className="text-xs text-muted-foreground">
                          {(q.responseTimeMs / 1000).toFixed(1)}s
                        </span>
                      )}
                      {q.modelUsed && (
                        <Badge variant="secondary" className="text-xs py-0">
                          {q.modelUsed}
                        </Badge>
                      )}
                      {q.sources && (q.sources as QuerySource[]).length > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <BookOpen className="h-3 w-3" />
                          {(q.sources as QuerySource[]).length} 处引用
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 详情弹窗 */}
      <Dialog open={!!selectedQuery} onOpenChange={() => setSelectedQuery(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">查询详情</DialogTitle>
          </DialogHeader>
          {selectedQuery && (
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">学生问题</p>
                <p className="font-medium text-foreground">{selectedQuery.question}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">系统答案</p>
                <div className="prose prose-sm max-w-none text-foreground bg-muted/30 rounded-lg p-3">
                  <Streamdown>{selectedQuery.answer}</Streamdown>
                </div>
              </div>
              {selectedQuery.sources && (selectedQuery.sources as QuerySource[]).length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-2">引用来源</p>
                  <div className="space-y-2">
                    {(selectedQuery.sources as QuerySource[]).map((s, idx) => (
                      <div key={idx} className="border-l-4 border-primary/50 bg-primary/5 rounded-r-lg p-3">
                        <p className="text-xs font-medium text-primary mb-1">
                          {[s.materialTitle, s.chapter, s.pageStart ? `第${s.pageStart}页` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        <p className="text-xs text-foreground/80">{s.excerpt}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2 border-t border-border">
                <span>{new Date(selectedQuery.createdAt).toLocaleString("zh-CN")}</span>
                {selectedQuery.visitorCity && <span>{selectedQuery.visitorCity}</span>}
                {selectedQuery.visitorIp && <span>IP: {selectedQuery.visitorIp}</span>}
                {selectedQuery.modelUsed && <span>模型: {selectedQuery.modelUsed}</span>}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
