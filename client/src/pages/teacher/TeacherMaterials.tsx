import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
import { Upload, Trash2, BookOpen, FileText, CheckCircle, XCircle, Loader2, RefreshCw } from "lucide-react";
import type { MaterialStatus } from "@/types";

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk

const STATUS_LABELS: Record<MaterialStatus, { label: string; color: string; icon: React.ReactNode }> = {
  uploading: { label: "上传中", color: "bg-blue-100 text-blue-700", icon: <Upload className="h-3 w-3" /> },
  processing: { label: "处理中", color: "bg-yellow-100 text-yellow-700", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  published: { label: "已发布", color: "bg-green-100 text-green-700", icon: <CheckCircle className="h-3 w-3" /> },
  error: { label: "处理失败", color: "bg-red-100 text-red-700", icon: <XCircle className="h-3 w-3" /> },
};

export default function TeacherMaterials() {
  const utils = trpc.useUtils();
  const { data: materials, isLoading, refetch } = trpc.materials.list.useQuery();
  const deleteMutation = trpc.materials.delete.useMutation({
    onSuccess: () => { utils.materials.list.invalidate(); toast.success("教材已删除"); },
    onError: (e) => toast.error(`删除失败: ${e.message}`),
  });
  const reprocessMutation = trpc.materials.reprocess.useMutation({
    onSuccess: () => { utils.materials.list.invalidate(); toast.success("已开始重新处理，请稍候刷新查看状态"); },
    onError: (e) => toast.error(`重新处理失败: ${e.message}`),
  });
  const reprocessAllMutation = trpc.materials.reprocessAll.useMutation({
    onSuccess: (data) => {
      utils.materials.list.invalidate();
      if (data.started > 0) {
        toast.success(`已开始重新处理 ${data.started}/${data.total} 本教材`);
      }
      if (data.failures && data.failures.length > 0) {
        const details = data.failures.map((f: { title: string; reason: string }) => `「${f.title}」: ${f.reason}`).join("\n");
        toast.error(`${data.failures.length} 本教材处理失败:\n${details}`, { duration: 8000 });
      }
      if (data.started === 0 && (!data.failures || data.failures.length === 0)) {
        toast("没有找到需要重新处理的教材");
      }
    },
    onError: (e) => toast.error(`批量处理失败: ${e.message}`),
  });

  const [uploadOpen, setUploadOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">教材管理</h1>
          <p className="text-muted-foreground text-sm mt-1">上传和管理教学教材，支持 100MB+ 大文件</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => reprocessAllMutation.mutate()}
            disabled={reprocessAllMutation.isPending}
          >
            {reprocessAllMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            全部重新处理
          </Button>
          <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
            <DialogTrigger asChild>
              <Button>
                <Upload className="h-4 w-4 mr-2" />
                上传教材
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>上传教材 PDF</DialogTitle>
              </DialogHeader>
              <UploadForm
                onSuccess={() => {
                  setUploadOpen(false);
                  utils.materials.list.invalidate();
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 教材列表 */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">加载中...</div>
      ) : (materials || []).length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <BookOpen className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
            <p className="text-muted-foreground">暂无教材，请上传第一本教材</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {(materials || []).map((mat) => {
            const statusInfo = STATUS_LABELS[mat.status as MaterialStatus] || STATUS_LABELS.error;
            return (
              <Card key={mat.id} className="hover:shadow-sm transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                      <FileText className="h-6 w-6 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-semibold text-foreground">{mat.title}</h3>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {[mat.author, mat.publisher, mat.publishYear, mat.edition]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                            {statusInfo.icon}
                            {statusInfo.label}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        {mat.totalChunks ? <span>{mat.totalChunks} 个文本块</span> : null}
                        {mat.fileSizeBytes ? (
                          <span>{(mat.fileSizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                        ) : null}
                        <span>{new Date(mat.createdAt).toLocaleDateString("zh-CN")}</span>
                        {mat.hasFile === false && (
                          <span className="text-amber-600">原始文件缺失</span>
                        )}
                      </div>
                      {mat.status === "error" && mat.errorMessage && (
                        <p className="text-xs text-destructive mt-1">{mat.errorMessage}</p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-primary shrink-0"
                      title={mat.hasFile === false ? "原始文件缺失，需重新上传后才能重新处理" : "重新处理"}
                      disabled={reprocessMutation.isPending || mat.status === "processing" || mat.hasFile === false}
                      onClick={() => reprocessMutation.mutate({ id: mat.id })}
                    >
                      <RefreshCw className={`h-4 w-4 ${mat.status === "processing" ? "animate-spin" : ""}`} />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive shrink-0">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>确认删除教材</AlertDialogTitle>
                          <AlertDialogDescription>
                            删除《{mat.title}》将同时删除所有相关文本块和向量数据，此操作不可撤销。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteMutation.mutate({ id: mat.id })}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            确认删除
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 上传表单组件 ─────────────────────────────────────────────────────────────
function UploadForm({ onSuccess }: { onSuccess: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [publisher, setPublisher] = useState("");
  const [publishYear, setPublishYear] = useState("");
  const [edition, setEdition] = useState("");
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const initUpload = trpc.materials.initUpload.useMutation();
  const uploadChunk = trpc.materials.uploadChunk.useMutation();
  const finalizeUpload = trpc.materials.finalizeUpload.useMutation();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ext = f.name.toLowerCase().split(".").pop();
    if (!["pdf", "doc", "docx"].includes(ext || "")) {
      toast.error("仅支持 PDF 和 Word (.doc/.docx) 格式");
      return;
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.(pdf|docx?)$/i, ""));
  };

  const handleUpload = async () => {
    if (!file || !title.trim()) {
      toast.error("请选择文件并填写教材标题");
      return;
    }

    setUploading(true);
    setProgress(0);

    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      // 1. 初始化上传会话
      setStatusText("初始化上传...");
      const { sessionId } = await initUpload.mutateAsync({
        filename: file.name,
        totalSize: file.size,
        totalChunks,
        title,
        author,
        publisher,
        publishYear,
        edition,
        language,
      });

      // 2. 分块上传（带重试机制）
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        setStatusText(`上传分块 ${i + 1}/${totalChunks}...`);

        // 将 chunk 转为 base64
        const arrayBuffer = await chunk.arrayBuffer();
        const base64 = btoa(
          Array.from(new Uint8Array(arrayBuffer)).map((b) => String.fromCharCode(b)).join("")
        );

        // 重试逻辑：最多重试 3 次，指数退避
        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await uploadChunk.mutateAsync({
              sessionId,
              chunkIndex: i,
              chunkData: base64,
              isLastChunk: i === totalChunks - 1,
            });
            lastErr = null;
            break;
          } catch (err: any) {
            lastErr = err;
            if (attempt < 3) {
              const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
              setStatusText(`分块 ${i + 1} 上传失败，${delay / 1000}秒后重试...`);
              await new Promise(r => setTimeout(r, delay));
            }
          }
        }
        if (lastErr) throw lastErr;

        setProgress(Math.round(((i + 1) / totalChunks) * 80));
      }

      // 3. 完成上传并触发处理
      setStatusText("合并文件并开始处理...");
      setProgress(85);
      await finalizeUpload.mutateAsync({
        sessionId,
        title,
        author: author || undefined,
        publisher: publisher || undefined,
        publishYear: publishYear || undefined,
        edition: edition || undefined,
        language,
      });

      setProgress(100);
      setStatusText("上传成功，正在后台处理教材...");
      toast.success("教材上传成功，正在后台处理（向量化可能需要几分钟）");
      onSuccess();
    } catch (err: any) {
      toast.error(`上传失败: ${err.message || "请重试"}`);
      setUploading(false);
      setProgress(0);
      setStatusText("");
    }
  };

  return (
    <div className="space-y-4">
      {/* 文件选择 */}
      <div
        className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={handleFileChange}
          disabled={uploading}
        />
        {file ? (
          <div className="space-y-1">
            <FileText className="h-8 w-8 text-primary mx-auto" />
            <p className="font-medium text-sm">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Upload className="h-8 w-8 text-muted-foreground/50 mx-auto" />
            <p className="text-sm text-muted-foreground">点击选择 PDF 或 Word 文件</p>
            <p className="text-xs text-muted-foreground">支持 100MB+ 大文件</p>
          </div>
        )}
      </div>

      {/* 元数据表单 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label htmlFor="title">教材标题 *</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例：森林培育学（第三版）"
            disabled={uploading}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="author">作者</Label>
          <Input
            id="author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="例：沈国舫"
            disabled={uploading}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="publisher">出版社</Label>
          <Input
            id="publisher"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
            placeholder="例：中国林业出版社"
            disabled={uploading}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="publishYear">出版年份</Label>
          <Input
            id="publishYear"
            value={publishYear}
            onChange={(e) => setPublishYear(e.target.value)}
            placeholder="例：2011"
            disabled={uploading}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="edition">版次</Label>
          <Input
            id="edition"
            value={edition}
            onChange={(e) => setEdition(e.target.value)}
            placeholder="例：第三版"
            disabled={uploading}
            className="mt-1"
          />
        </div>
        <div className="col-span-2">
          <Label className="text-sm font-medium">教材语言</Label>
          <Select value={language} onValueChange={(v) => setLanguage(v as "zh" | "en")}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            也可上传后由系统自动检测
          </p>
        </div>
      </div>

      {/* 上传进度 */}
      {uploading && (
        <div className="space-y-2">
          <Progress value={progress} className="h-2" />
          <p className="text-xs text-muted-foreground text-center">{statusText}</p>
        </div>
      )}

      <Button
        onClick={handleUpload}
        disabled={!file || !title.trim() || uploading}
        className="w-full"
      >
        {uploading ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {statusText || "上传中..."}
          </>
        ) : (
          <>
            <Upload className="h-4 w-4 mr-2" />
            开始上传
          </>
        )}
      </Button>
    </div>
  );
}
