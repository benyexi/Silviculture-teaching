import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Login from "./pages/Login";
import TeacherLayout from "./pages/teacher/TeacherLayout";
import TeacherDashboard from "./pages/teacher/TeacherDashboard";
import TeacherMaterials from "./pages/teacher/TeacherMaterials";
import TeacherQueries from "./pages/teacher/TeacherQueries";
import TeacherLlmConfig from "./pages/teacher/TeacherLlmConfig";

function Router() {
  return (
    <Switch>
      {/* 学生端（公开） */}
      <Route path="/" component={Home} />
      <Route path="/login" component={Login} />

      {/* 教师端（需要 admin 角色） */}
      <Route path="/teacher">
        {() => (
          <TeacherLayout>
            <TeacherDashboard />
          </TeacherLayout>
        )}
      </Route>
      <Route path="/teacher/materials">
        {() => (
          <TeacherLayout>
            <TeacherMaterials />
          </TeacherLayout>
        )}
      </Route>
      <Route path="/teacher/queries">
        {() => (
          <TeacherLayout>
            <TeacherQueries />
          </TeacherLayout>
        )}
      </Route>
      <Route path="/teacher/llm-config">
        {() => (
          <TeacherLayout>
            <TeacherLlmConfig />
          </TeacherLayout>
        )}
      </Route>

      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
