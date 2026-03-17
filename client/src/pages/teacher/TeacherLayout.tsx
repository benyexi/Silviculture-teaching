import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  LayoutDashboard,
  BookOpen,
  MessageSquare,
  Settings,
  TreePine,
  LogOut,
  ChevronRight,
} from "lucide-react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";

const NAV_ITEMS = [
  { href: "/teacher", label: "统计概览", icon: LayoutDashboard, exact: true },
  { href: "/teacher/materials", label: "教材管理", icon: BookOpen },
  { href: "/teacher/queries", label: "查询记录", icon: MessageSquare },
  { href: "/teacher/llm-config", label: "模型配置", icon: Settings },
];

export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [location, navigate] = useLocation();
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => navigate("/"),
  });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">加载中...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <TreePine className="h-12 w-12 text-primary mx-auto" />
          <h2 className="text-xl font-semibold">教师登录</h2>
          <p className="text-muted-foreground text-sm">请登录以访问教师管理后台</p>
          <Button asChild>
            <a href={getLoginUrl()}>登录</a>
          </Button>
        </div>
      </div>
    );
  }

  if (user.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <div className="text-4xl">🚫</div>
          <h2 className="text-xl font-semibold">权限不足</h2>
          <p className="text-muted-foreground text-sm">您没有访问教师后台的权限，请联系管理员。</p>
          <Button variant="outline" asChild>
            <a href="/">返回首页</a>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-background">
      {/* 侧边栏 */}
      <aside className="w-60 shrink-0 flex flex-col" style={{ background: "var(--sidebar)" }}>
        {/* Logo */}
        <div className="h-14 flex items-center gap-2 px-4 border-b border-sidebar-border">
          <TreePine className="h-6 w-6 text-sidebar-primary" />
          <span className="font-semibold text-sidebar-foreground text-sm leading-tight">
            森林培育学<br />
            <span className="text-xs font-normal text-sidebar-foreground/70">教师管理后台</span>
          </span>
        </div>

        {/* 导航 */}
        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = item.exact
              ? location === item.href
              : location.startsWith(item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </a>
            );
          })}
        </nav>

        {/* 底部用户信息 */}
        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2 px-2 py-1 mb-2">
            <div className="w-7 h-7 rounded-full bg-sidebar-primary/30 flex items-center justify-center text-xs text-sidebar-foreground font-medium">
              {user.name?.charAt(0) || "T"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-sidebar-foreground truncate">{user.name}</p>
              <p className="text-xs text-sidebar-foreground/60">教师</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent text-xs gap-2"
            onClick={() => logoutMutation.mutate()}
          >
            <LogOut className="h-3.5 w-3.5" />
            退出登录
          </Button>
          <a
            href="/"
            className="flex items-center gap-2 px-2 py-1.5 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground mt-1"
          >
            <ChevronRight className="h-3.5 w-3.5" />
            返回学生端
          </a>
        </div>
      </aside>

      {/* 主内容区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 p-6 overflow-auto">{children}</main>
        <footer className="border-t border-border/40 py-3 px-6 bg-white/60">
          <p className="text-xs text-muted-foreground text-center">
            本系统由北京林业大学森林培育学科席本野开发
          </p>
        </footer>
      </div>
    </div>
  );
}
