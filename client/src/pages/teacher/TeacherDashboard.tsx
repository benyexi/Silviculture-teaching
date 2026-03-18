import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from "recharts";
import { MessageSquare, Users, BookOpen, TrendingUp, MapPin, HardDrive, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";

export default function TeacherDashboard() {
  const { data, isLoading } = trpc.stats.overview.useQuery();
  const { data: lowRatedQuestions } = trpc.qa.getLowRatedQuestions.useQuery();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">统计概览</h1>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const { queryStats, topQuestions, materialUsage, visitorData } = data || {};

  // 处理访客趋势数据（最近 14 天）
  const trendData = (visitorData || [])
    .slice(0, 14)
    .reverse()
    .map((d) => ({
      date: d.date.slice(5), // MM-DD
      查询数: d.totalQueries || 0,
      访客数: d.totalVisitors || 0,
    }));

  // 地区分布数据（汇总所有日期）
  const cityMap: Record<string, number> = {};
  (visitorData || []).forEach((d) => {
    const dist = (d.cityDistribution as Record<string, number>) || {};
    Object.entries(dist).forEach(([city, count]) => {
      cityMap[city] = (cityMap[city] || 0) + count;
    });
  });
  const cityData = Object.entries(cityMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([city, count]) => ({ city, count }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">统计概览</h1>
        <p className="text-muted-foreground text-sm mt-1">查看系统使用情况和学生查询统计</p>
      </div>

      {/* 核心指标卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="累计查询"
          value={queryStats?.total ?? 0}
          icon={<MessageSquare className="h-5 w-5" />}
          color="text-primary"
          bg="bg-primary/10"
        />
        <StatCard
          title="今日查询"
          value={queryStats?.today ?? 0}
          icon={<TrendingUp className="h-5 w-5" />}
          color="text-chart-2"
          bg="bg-chart-2/10"
        />
        <StatCard
          title="已上传教材"
          value={materialUsage?.length ?? 0}
          icon={<BookOpen className="h-5 w-5" />}
          color="text-chart-4"
          bg="bg-chart-4/10"
        />
        <StatCard
          title="覆盖城市"
          value={Object.keys(cityMap).length}
          icon={<MapPin className="h-5 w-5" />}
          color="text-chart-5"
          bg="bg-chart-5/10"
        />
      </div>

      {/* 查询趋势图 */}
      {trendData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">近 14 天查询趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="查询数" stroke="var(--primary)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="访客数" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">待改进问题</CardTitle>
          </CardHeader>
          <CardContent>
            {(lowRatedQuestions || []).length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-8">暂无待改进问题</p>
            ) : (
              <div className="space-y-3">
                {(lowRatedQuestions || []).map((q: any) => (
                  <div key={q.id} className="rounded-lg border border-border p-3">
                    <p className="text-sm text-foreground line-clamp-2">{q.question}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <Badge variant="outline" className="text-red-500 border-red-200">
                        差评率 {q.unhelpful_rate}%
                      </Badge>
                      <Badge variant="secondary">差评 {q.unhelpful_count}</Badge>
                      <Badge variant="secondary">反馈 {q.total_feedback}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 热门问题 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">热门问题 Top 10</CardTitle>
          </CardHeader>
          <CardContent>
            {(topQuestions || []).length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-8">暂无查询记录</p>
            ) : (
              <div className="space-y-2">
                {(topQuestions || []).map((q, idx) => (
                  <div key={idx} className="flex items-start gap-3">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0 mt-0.5">
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">{q.question}</p>
                      <p className="text-xs text-muted-foreground">{q.count} 次</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 地区分布 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">访客城市分布 Top 10</CardTitle>
          </CardHeader>
          <CardContent>
            {cityData.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-8">暂无访客数据</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={cityData} layout="vertical">
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="city" type="category" tick={{ fontSize: 11 }} width={60} />
                  <Tooltip />
                  <Bar dataKey="count" fill="var(--primary)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 教材使用率 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">教材使用率排行</CardTitle>
        </CardHeader>
        <CardContent>
          {(materialUsage || []).length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">暂无教材数据</p>
          ) : (
            <div className="space-y-3">
              {(materialUsage || []).map((m, idx) => {
                const maxCount = Math.max(...(materialUsage || []).map((x) => x.usageCount), 1);
                const pct = Math.round((m.usageCount / maxCount) * 100);
                return (
                  <div key={m.id} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-foreground truncate max-w-xs">{m.title}</span>
                      <span className="text-muted-foreground shrink-0 ml-2">{m.usageCount} 次引用</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 数据库存储管理 */}
      <StorageCard />
    </div>
  );
}

function StorageCard() {
  const utils = trpc.useUtils();
  const { data: storage, isLoading } = trpc.stats.storage.useQuery();
  const [cleaning, setCleaning] = useState(false);

  const cleanupMutation = trpc.stats.cleanup.useMutation({
    onSuccess: (result) => {
      utils.stats.storage.invalidate();
      const msgs: string[] = [];
      if (result.queriesPurged) msgs.push(`清理了 ${result.queriesPurged} 条旧查询`);
      if (result.sessionsPurged) msgs.push(`清理了 ${result.sessionsPurged} 个上传会话`);
      if (result.embeddingsCleared) msgs.push("已清空 Embedding 数据");
      toast.success(msgs.length > 0 ? msgs.join("；") : "无需清理");
      setCleaning(false);
    },
    onError: (e) => { toast.error(`清理失败: ${e.message}`); setCleaning(false); },
  });

  const handleCleanup = () => {
    setCleaning(true);
    cleanupMutation.mutate({
      purgeQueriesOlderThanDays: 90,
      purgeUploadSessions: true,
    });
  };

  const handleClearEmbeddings = () => {
    if (!confirm("确定要清空所有 Embedding 数据吗？这会释放大量空间，但向量搜索将回退为关键词搜索，直到重新处理教材。")) return;
    setCleaning(true);
    cleanupMutation.mutate({ clearEmbeddings: true });
  };

  const tableSizes = (storage?.tableSizes || []) as { tableName: string; tableMB: string }[];
  const totalMB = tableSizes.reduce((sum, t) => sum + parseFloat(t.tableMB || "0"), 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <HardDrive className="h-4 w-4" />
            数据库存储
          </CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleCleanup} disabled={cleaning || isLoading}>
              {cleaning ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
              清理旧数据
            </Button>
            <Button size="sm" variant="outline" onClick={handleClearEmbeddings} disabled={cleaning || isLoading} className="text-destructive hover:text-destructive">
              清空 Embedding
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-muted-foreground text-sm text-center py-4">加载中...</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              数据库总占用约 <span className="font-semibold text-foreground">{totalMB.toFixed(1)} MB</span>
              {storage?.tables && (
                <span> | 文档块 {storage.tables.materialChunks} 条 | 查询记录 {storage.tables.queries} 条</span>
              )}
            </p>
            <div className="space-y-1">
              {tableSizes.slice(0, 5).map((t) => {
                const pct = totalMB > 0 ? (parseFloat(t.tableMB) / totalMB) * 100 : 0;
                return (
                  <div key={t.tableName} className="flex items-center gap-2 text-xs">
                    <span className="w-32 truncate text-muted-foreground font-mono">{t.tableName}</span>
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.max(pct, 1)}%` }} />
                    </div>
                    <span className="w-16 text-right text-muted-foreground">{t.tableMB} MB</span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              「清理旧数据」将删除 90 天前的查询记录和已完成的上传会话。「清空 Embedding」可释放大量空间但搜索精度会降低。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatCard({
  title,
  value,
  icon,
  color,
  bg,
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  bg: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${bg} ${color}`}>{icon}</div>
          <div>
            <p className="text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">{title}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
