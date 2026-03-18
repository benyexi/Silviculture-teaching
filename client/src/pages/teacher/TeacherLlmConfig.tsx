import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Plus, Trash2, CheckCircle, Settings, Zap, Loader2, Pencil } from "lucide-react";
import { LLM_PROVIDER_LABELS, LLM_PROVIDER_DEFAULT_MODELS, type LlmProvider } from "@/types";

const PROVIDERS: LlmProvider[] = ["openai", "deepseek", "qwen", "ollama", "custom"];

export default function TeacherLlmConfig() {
  const utils = trpc.useUtils();
  const { data: configs, isLoading } = trpc.llmConfig.list.useQuery();
  const [addOpen, setAddOpen] = useState(false);
  const [editConfig, setEditConfig] = useState<{
    id: number;
    name: string;
    modelName: string;
    apiBaseUrl?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
    embeddingModel?: string | null;
    embeddingBaseUrl?: string | null;
  } | null>(null);

  const setActiveMutation = trpc.llmConfig.setActive.useMutation({
    onSuccess: () => {
      utils.llmConfig.list.invalidate();
      utils.llmConfig.getActive.invalidate();
      toast.success("模型已切换，立即生效");
    },
    onError: (e) => toast.error(`切换失败: ${e.message}`),
  });

  const deleteMutation = trpc.llmConfig.delete.useMutation({
    onSuccess: () => { utils.llmConfig.list.invalidate(); toast.success("配置已删除"); },
    onError: (e) => toast.error(`删除失败: ${e.message}`),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">模型配置</h1>
          <p className="text-muted-foreground text-sm mt-1">
            管理 LLM 驱动模型，随时切换，立即生效，无需重启
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              添加模型配置
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>添加 LLM 模型配置</DialogTitle>
            </DialogHeader>
            <AddConfigForm
              onSuccess={() => {
                setAddOpen(false);
                utils.llmConfig.list.invalidate();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* 说明卡片 */}
      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Zap className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-foreground mb-1">模型切换说明</p>
              <p className="text-muted-foreground">
                点击「设为当前」可立即切换答案生成所使用的模型，无需重启系统。
                支持 OpenAI、DeepSeek、通义千问、Ollama 本地模型等。
                若未配置任何模型，系统将使用内置默认模型。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 配置列表 */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">加载中...</div>
      ) : (configs || []).length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <Settings className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
            <p className="text-muted-foreground">暂无模型配置</p>
            <p className="text-sm text-muted-foreground mt-1">添加配置后可切换模型驱动</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {(configs || []).map((config) => (
            <Card
              key={config.id}
              className={`transition-shadow ${config.isActive ? "border-primary/50 shadow-sm" : ""}`}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-4">
                  <div className={`p-2 rounded-lg shrink-0 ${config.isActive ? "bg-primary/10" : "bg-muted"}`}>
                    <Settings className={`h-5 w-5 ${config.isActive ? "text-primary" : "text-muted-foreground"}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-foreground">{config.name}</h3>
                      {config.isActive && (
                        <Badge className="bg-primary text-primary-foreground text-xs">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          当前使用
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <Badge variant="secondary" className="text-xs">
                        {LLM_PROVIDER_LABELS[config.provider as LlmProvider] || config.provider}
                      </Badge>
                      <span className="text-sm text-muted-foreground">{config.modelName}</span>
                      {config.apiKey && (
                        <span className="text-xs text-muted-foreground font-mono">{config.apiKey}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!config.isActive && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setActiveMutation.mutate({ id: config.id })}
                        disabled={setActiveMutation.isPending}
                      >
                        {setActiveMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          "设为当前"
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-primary"
                      onClick={() => setEditConfig({
                        id: config.id,
                        name: config.name,
                        modelName: config.modelName,
                        apiBaseUrl: config.apiBaseUrl,
                        temperature: config.temperature,
                        maxTokens: config.maxTokens,
                        embeddingModel: config.embeddingModel,
                        embeddingBaseUrl: config.embeddingBaseUrl,
                      })}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>确认删除配置</AlertDialogTitle>
                          <AlertDialogDescription>
                            删除「{config.name}」配置后无法恢复。如果这是当前使用的模型，系统将回退到内置默认模型。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteMutation.mutate({ id: config.id })}
                            className="bg-destructive text-destructive-foreground"
                          >
                            确认删除
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 编辑配置弹窗 */}
      <Dialog open={!!editConfig} onOpenChange={(open) => { if (!open) setEditConfig(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑模型配置</DialogTitle>
          </DialogHeader>
          {editConfig && (
            <EditConfigForm
              config={editConfig}
              onSuccess={() => {
                setEditConfig(null);
                utils.llmConfig.list.invalidate();
                utils.llmConfig.getActive.invalidate();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── 编辑配置表单 ─────────────────────────────────────────────────────────────
function EditConfigForm({
  config,
  onSuccess,
}: {
  config: {
    id: number;
    name: string;
    modelName: string;
    apiBaseUrl?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
    embeddingModel?: string | null;
    embeddingBaseUrl?: string | null;
  };
  onSuccess: () => void;
}) {
  const [name, setName] = useState(config.name);
  const [modelName, setModelName] = useState(config.modelName);
  const [apiKey, setApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(config.apiBaseUrl || "");
  const [temperature, setTemperature] = useState(String(config.temperature ?? 0.1));
  const [maxTokens, setMaxTokens] = useState(String(config.maxTokens ?? 4096));
  const [embeddingModel, setEmbeddingModel] = useState(config.embeddingModel || "");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState(config.embeddingBaseUrl || "");

  const updateMutation = trpc.llmConfig.update.useMutation({
    onSuccess: () => { toast.success("配置已更新"); onSuccess(); },
    onError: (e) => toast.error(`更新失败: ${e.message}`),
  });

  const handleSubmit = () => {
    const data: Record<string, unknown> = { id: config.id };
    if (name !== config.name) data.name = name;
    if (modelName !== config.modelName) data.modelName = modelName;
    if (apiKey) data.apiKey = apiKey; // 只在填写了新 key 时更新
    if (apiBaseUrl !== (config.apiBaseUrl || "")) data.apiBaseUrl = apiBaseUrl || undefined;
    if (parseFloat(temperature) !== (config.temperature ?? 0.1)) data.temperature = parseFloat(temperature);
    if (parseInt(maxTokens) !== (config.maxTokens ?? 4096)) data.maxTokens = parseInt(maxTokens);
    if (embeddingModel !== (config.embeddingModel || "")) data.embeddingModel = embeddingModel || undefined;
    if (embeddingApiKey) data.embeddingApiKey = embeddingApiKey;
    if (embeddingBaseUrl !== (config.embeddingBaseUrl || "")) data.embeddingBaseUrl = embeddingBaseUrl || undefined;

    if (Object.keys(data).length <= 1) {
      toast.info("没有需要更新的内容");
      return;
    }

    updateMutation.mutate(data as Parameters<typeof updateMutation.mutate>[0]);
  };

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label>配置名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
        </div>
        <div className="col-span-2">
          <Label>模型名称</Label>
          <Input value={modelName} onChange={(e) => setModelName(e.target.value)} className="mt-1" />
        </div>
        <div className="col-span-2">
          <Label>API Key（留空则不修改）</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="输入新的 API Key 以替换旧的"
            className="mt-1"
          />
        </div>
        <div className="col-span-2">
          <Label>API Base URL</Label>
          <Input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label>Temperature（0-2）</Label>
          <Input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label>Max Tokens</Label>
          <Input type="number" min="100" max="32000" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className="mt-1" />
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-sm font-medium text-foreground mb-3">Embedding 配置</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Embedding 模型</Label>
            <Input value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Embedding API Key（留空则不修改）</Label>
            <Input type="password" value={embeddingApiKey} onChange={(e) => setEmbeddingApiKey(e.target.value)} className="mt-1" />
          </div>
          <div className="col-span-2">
            <Label>Embedding Base URL</Label>
            <Input value={embeddingBaseUrl} onChange={(e) => setEmbeddingBaseUrl(e.target.value)} className="mt-1" />
          </div>
        </div>
      </div>

      <Button onClick={handleSubmit} disabled={updateMutation.isPending} className="w-full">
        {updateMutation.isPending ? (
          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />保存中...</>
        ) : (
          "保存修改"
        )}
      </Button>
    </div>
  );
}

// ─── 添加配置表单 ─────────────────────────────────────────────────────────────
function AddConfigForm({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<LlmProvider>("openai");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [temperature, setTemperature] = useState("0.1");
  const [maxTokens, setMaxTokens] = useState("4096");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");

  const createMutation = trpc.llmConfig.create.useMutation({
    onSuccess: () => { toast.success("模型配置已添加"); onSuccess(); },
    onError: (e) => toast.error(`添加失败: ${e.message}`),
  });

  const defaultModels = LLM_PROVIDER_DEFAULT_MODELS[provider] || [];

  const handleProviderChange = (p: LlmProvider) => {
    setProvider(p);
    setModelName(LLM_PROVIDER_DEFAULT_MODELS[p]?.[0] || "");
    // 自动填充默认 Base URL
    const defaultUrls: Partial<Record<LlmProvider, string>> = {
      deepseek: "https://api.deepseek.com",
      qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ollama: "http://localhost:11434/v1",
    };
    setApiBaseUrl(defaultUrls[p] || "");
  };

  const handleSubmit = () => {
    if (!name.trim() || !modelName.trim()) {
      toast.error("请填写配置名称和模型名称");
      return;
    }
    createMutation.mutate({
      name,
      provider,
      modelName,
      apiKey: apiKey || undefined,
      apiBaseUrl: apiBaseUrl || undefined,
      temperature: parseFloat(temperature) || 0.1,
      maxTokens: parseInt(maxTokens) || 4096,
      embeddingModel: embeddingModel || undefined,
      embeddingApiKey: embeddingApiKey || undefined,
      embeddingBaseUrl: embeddingBaseUrl || undefined,
    });
  };

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label>配置名称 *</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：DeepSeek Chat"
            className="mt-1"
          />
        </div>

        <div>
          <Label>模型提供商 *</Label>
          <Select value={provider} onValueChange={(v) => handleProviderChange(v as LlmProvider)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {LLM_PROVIDER_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>模型名称 *</Label>
          {defaultModels.length > 0 ? (
            <Select value={modelName} onValueChange={setModelName}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {defaultModels.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
                <SelectItem value="__custom__">自定义...</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="输入模型名称"
              className="mt-1"
            />
          )}
          {modelName === "__custom__" && (
            <Input
              value=""
              onChange={(e) => setModelName(e.target.value)}
              placeholder="输入自定义模型名称"
              className="mt-1"
            />
          )}
        </div>

        <div className="col-span-2">
          <Label>API Key</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-... 或对应的 API Key"
            className="mt-1"
          />
        </div>

        <div className="col-span-2">
          <Label>API Base URL</Label>
          <Input
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1（留空使用默认）"
            className="mt-1"
          />
        </div>

        <div>
          <Label>Temperature（0-2）</Label>
          <Input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            className="mt-1"
          />
        </div>

        <div>
          <Label>Max Tokens</Label>
          <Input
            type="number"
            min="100"
            max="32000"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            className="mt-1"
          />
        </div>
      </div>

      {/* Embedding 配置（可选） */}
      <div className="border-t border-border pt-4">
        <p className="text-sm font-medium text-foreground mb-3">Embedding 配置（可选，用于向量化）</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Embedding 模型</Label>
            <Input
              value={embeddingModel}
              onChange={(e) => setEmbeddingModel(e.target.value)}
              placeholder="text-embedding-3-small"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Embedding API Key</Label>
            <Input
              type="password"
              value={embeddingApiKey}
              onChange={(e) => setEmbeddingApiKey(e.target.value)}
              placeholder="留空则使用主 API Key"
              className="mt-1"
            />
          </div>
          <div className="col-span-2">
            <Label>Embedding Base URL</Label>
            <Input
              value={embeddingBaseUrl}
              onChange={(e) => setEmbeddingBaseUrl(e.target.value)}
              placeholder="留空则使用主 Base URL"
              className="mt-1"
            />
          </div>
        </div>
      </div>

      <Button
        onClick={handleSubmit}
        disabled={createMutation.isPending}
        className="w-full"
      >
        {createMutation.isPending ? (
          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />添加中...</>
        ) : (
          "添加配置"
        )}
      </Button>
    </div>
  );
}
