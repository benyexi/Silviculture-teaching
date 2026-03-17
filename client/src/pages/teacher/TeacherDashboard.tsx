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
import { MessageSquare, Users, BookOpen, TrendingUp, MapPin } from "lucide-react";

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
    </div>
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
