# CODEX 协作开发 PROMPT 文档

> **仓库地址**：https://github.com/benyexi/Silviculture-teaching  
> **项目路径**：根目录即项目根，主要工作目录为 `server/` 和 `client/src/`  
> **技术栈**：React 19 + TypeScript + TailwindCSS 4 + Express + tRPC 11 + Drizzle ORM + MySQL

---

## 使用说明

每个 PROMPT 任务均包含：
- **目标文件**：需要修改或新建的文件路径
- **任务描述**：详细的功能需求
- **接口约定**：函数签名、输入输出格式
- **关键要求**：必须满足的约束条件
- **测试要求**：需要编写的测试用例

CODEX 工作流程：
1. 克隆仓库：`git clone https://github.com/benyexi/Silviculture-teaching.git`
2. 安装依赖：`pnpm install`
3. 按照 PROMPT 修改对应文件
4. 本地测试：`pnpm test`
5. 提交并推送：`git add . && git commit -m "feat: xxx" && git push origin main`

---

## PROMPT #1：PDF 文本提取优化（处理扫描件和图片型 PDF）

### 目标文件
- `server/pdfProcessor.ts`（修改现有文件）

### 背景
当前 `pdfProcessor.ts` 使用 `pdf-parse` 提取 PDF 文本，但对于扫描件（图片型 PDF）无法提取文字。需要增加 OCR 降级处理能力。

### 任务描述

在 `server/pdfProcessor.ts` 中，找到 `extractTextFromPdf` 函数，按以下逻辑增强：

```typescript
// 当前逻辑（保留）：
// 1. 使用 pdf-parse 提取文本
// 2. 如果提取的文本长度 < 100 字符（判定为扫描件），触发 OCR 降级

// 新增逻辑（OCR 降级）：
// 3. 使用 pdf2image（pnpm add pdf2image）将 PDF 每页转为图片
// 4. 使用 Tesseract.js（pnpm add tesseract.js）对每张图片进行 OCR
// 5. 合并所有页面的 OCR 结果
// 6. 在返回的文本中标注 "[OCR提取]" 前缀，提示质量可能较低
```

### 函数签名（保持不变，只修改内部实现）

```typescript
export async function extractTextFromPdf(
  pdfBuffer: Buffer,
  materialId: number
): Promise<{ text: string; pageCount: number; isOcr: boolean }>
```

### 关键要求
- OCR 仅在文本提取失败时触发（文本长度 < 100 字符）
- OCR 处理时间可能较长，需要更新 `materials` 表的 `status` 为 `"processing"` 并记录进度
- 调用 `updateMaterialStatus(materialId, 'processing', '正在 OCR 处理...')` 更新状态
- Tesseract 语言包必须包含中文（`chi_sim`）和英文（`eng`）
- 错误处理：OCR 失败时返回空文本，不抛出异常，记录错误日志

### 测试要求
在 `server/pdfProcessor.test.ts` 中添加：
```typescript
it('falls back to OCR for image-only PDF', async () => {
  // mock pdf-parse 返回空文本
  // mock Tesseract 返回 "森林培育学"
  // 验证返回结果包含 isOcr: true
})
```

---

## PROMPT #2：向量检索精度优化（智能分块策略）

### 目标文件
- `server/pdfProcessor.ts`（修改 `splitIntoChunks` 函数）
- `server/vectorSearch.ts`（修改 `semanticSearch` 函数）

### 背景
当前分块策略是按固定字符数（500字）分割，会破坏句子和段落的完整性，影响检索精度。

### 任务 A：改进分块策略（`server/pdfProcessor.ts`）

找到 `splitIntoChunks` 函数，按以下逻辑重写：

```typescript
export function splitIntoChunks(
  text: string,
  options?: {
    chunkSize?: number;      // 默认 600 字
    overlap?: number;        // 默认 100 字（相邻块重叠）
    respectSentences?: boolean; // 默认 true（不在句子中间切断）
  }
): Array<{
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
}>
```

**分块规则**：
1. 优先在段落边界（`\n\n`）切分
2. 其次在句子边界（`。！？\n`）切分
3. 相邻块之间保留 100 字重叠（overlap），确保上下文连续性
4. 每块最大 600 字，最小 100 字（太短的块合并到下一块）
5. 保留章节标题信息（以 `第X章`、`X.X` 开头的行视为标题）

### 任务 B：改进检索排序（`server/vectorSearch.ts`）

找到 `semanticSearch` 函数，在现有余弦相似度基础上增加重排序（reranking）：

```typescript
// 在检索到 Top-10 结果后，增加以下重排序逻辑：
// 1. 关键词匹配加分：问题中的关键词在文本块中出现，每个关键词 +0.05 分
// 2. 章节连续性加分：同一章节的相邻块，相似度 +0.02 分
// 3. 最终返回重排序后的 Top-5 结果
```

### 关键要求
- 分块结果必须保存 `startChar` 和 `endChar`，用于后续定位原文
- 重排序不得改变函数签名，只修改内部逻辑
- 性能：分块处理 100 页 PDF 应在 5 秒内完成

### 测试要求
```typescript
it('splits text at sentence boundaries', () => {
  const text = '森林培育学是研究森林培育的学科。它包括造林、抚育等内容。\n\n第二节 立地质量\n立地质量是指...'
  const chunks = splitIntoChunks(text, { chunkSize: 50 })
  // 验证不在句子中间切断
  chunks.forEach(chunk => {
    expect(chunk.content).not.toMatch(/^[，。！？]/) // 不以标点开头
  })
})
```

---

## PROMPT #3：答案生成 Prompt 调优（更严格的教材约束）

### 目标文件
- `server/qaService.ts`（修改 `buildSystemPrompt` 和 `buildUserPrompt` 函数）

### 背景
当前 System Prompt 对 LLM 的约束不够严格，有时会出现超出教材内容的自由发挥。需要优化 Prompt 策略。

### 任务描述

在 `server/qaService.ts` 中，找到或创建以下两个函数：

```typescript
/**
 * 构建系统提示词，严格约束 LLM 基于教材回答
 */
export function buildSystemPrompt(materialTitles: string[]): string {
  // 要求：
  // 1. 明确告知 LLM 它是"森林培育学教材助手"
  // 2. 严格要求：只能基于提供的教材片段回答，不得引用教材之外的知识
  // 3. 如果教材片段不足以回答问题，必须明确说明"教材中未涉及此内容"
  // 4. 回答格式要求：先给出直接答案，再给出详细解释，最后标注引用来源
  // 5. 对于教材中有多个观点的内容，必须列出全部观点
  // 6. 禁止使用"根据我的知识"、"通常认为"等表达，只能说"根据教材"
  // 7. 回答语言：中文，学术风格，与教材保持一致
}

/**
 * 构建用户提示词，包含检索到的教材片段
 */
export function buildUserPrompt(
  question: string,
  chunks: Array<{
    content: string;
    materialTitle: string;
    chapter?: string;
    pageStart?: number;
    pageEnd?: number;
  }>
): string {
  // 要求：
  // 1. 将每个教材片段格式化为带编号的引用块
  // 2. 每个引用块包含：来源标注（教材名、章节、页码）+ 原文内容
  // 3. 在问题之前提供所有教材片段
  // 4. 明确要求 LLM 在回答中标注使用了哪些片段（用 [引用1]、[引用2] 等）
}
```

### 输出格式约定

LLM 的回答必须遵循以下 JSON 结构（通过 `response_format` 强制）：

```typescript
interface QAResponse {
  answer: string;           // 主答案（Markdown 格式）
  found_in_materials: boolean; // 是否在教材中找到相关内容
  citation_indices: number[]; // 使用了哪些引用片段（1-based）
  confidence: 'high' | 'medium' | 'low'; // 答案置信度
}
```

### 关键要求
- 当 `found_in_materials: false` 时，`answer` 必须包含"教材中未涉及此内容"的提示
- `citation_indices` 必须与实际使用的片段对应，用于前端显示引用来源
- System Prompt 长度控制在 800 字以内，避免占用过多 token

### 测试要求
```typescript
it('returns not-found when no relevant chunks', async () => {
  // mock semanticSearch 返回空数组
  const result = await generateAnswer('量子力学的基本原理是什么？', [])
  expect(result.answer).toContain('教材中未涉及')
})

it('includes citation indices in response', async () => {
  // mock semanticSearch 返回 2 个片段
  const result = await generateAnswer('什么是立地质量？', mockChunks)
  expect(result.sources.length).toBeGreaterThan(0)
})
```

---

## PROMPT #4：阿里云 Docker Compose 部署配置

### 目标文件（全部新建）
- `docker-compose.yml`（根目录）
- `docker-compose.prod.yml`（生产环境覆盖）
- `Dockerfile`（根目录）
- `nginx/nginx.conf`（Nginx 配置）
- `scripts/deploy.sh`（一键部署脚本）
- `.env.example`（环境变量示例）

### 任务描述

创建完整的 Docker Compose 部署配置，支持在阿里云 ECS 服务器上一键部署。

#### `docker-compose.yml` 结构

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - JWT_SECRET=${JWT_SECRET}
      # 其他必要环境变量...
    volumes:
      - pdf_uploads:/app/uploads  # PDF 文件持久化存储
    depends_on:
      - mysql
    restart: unless-stopped

  mysql:
    image: mysql:8.0
    environment:
      - MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}
      - MYSQL_DATABASE=silviculture
      - MYSQL_USER=${MYSQL_USER}
      - MYSQL_PASSWORD=${MYSQL_PASSWORD}
    volumes:
      - mysql_data:/var/lib/mysql
    ports:
      - "3306:3306"  # 仅内网访问
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
      - ./nginx/ssl:/etc/nginx/ssl  # SSL 证书目录
    depends_on:
      - app
    restart: unless-stopped

volumes:
  mysql_data:
  pdf_uploads:
```

#### `Dockerfile` 要求
- 多阶段构建（builder + production）
- builder 阶段：安装依赖、构建前端（`pnpm build`）
- production 阶段：只复制构建产物和 `node_modules`
- 安装 `poppler-utils`（PDF 处理依赖）
- 暴露端口 3000
- 启动命令：`node dist/index.js`

#### `nginx/nginx.conf` 要求
- 反向代理到 `app:3000`
- 支持大文件上传（`client_max_body_size 200m`）
- 启用 gzip 压缩
- 静态文件缓存（`/assets/` 路径缓存 30 天）
- WebSocket 支持（用于 HMR，生产环境可选）
- HTTPS 配置模板（注释形式，用户填入证书路径）

#### `scripts/deploy.sh` 要求
```bash
#!/bin/bash
# 一键部署脚本
# 使用方式：./scripts/deploy.sh [--update]

# 1. 检查 Docker 和 Docker Compose 是否安装
# 2. 检查 .env 文件是否存在
# 3. 拉取最新代码（git pull）
# 4. 构建镜像（docker-compose build）
# 5. 启动服务（docker-compose up -d）
# 6. 运行数据库迁移（docker-compose exec app pnpm db:push）
# 7. 显示服务状态
```

#### `.env.example` 内容
```
# 数据库配置
DATABASE_URL=mysql://user:password@mysql:3306/silviculture
MYSQL_ROOT_PASSWORD=your_root_password
MYSQL_USER=silviculture_user
MYSQL_PASSWORD=your_password

# JWT 密钥（随机生成，至少 32 字符）
JWT_SECRET=your_jwt_secret_here

# Manus OAuth（从 Manus 平台获取）
VITE_APP_ID=your_app_id
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://manus.im

# 文件存储（本地存储路径）
UPLOAD_DIR=/app/uploads

# 可选：S3 对象存储（阿里云 OSS）
# S3_BUCKET=your-bucket-name
# S3_REGION=cn-hangzhou
# S3_ACCESS_KEY=your_access_key
# S3_SECRET_KEY=your_secret_key
# S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
```

### 关键要求
- 所有敏感信息通过环境变量注入，不得硬编码
- PDF 文件存储在 Docker Volume 中，确保重启后不丢失
- MySQL 数据也存储在 Volume 中
- Nginx 配置支持大文件上传（200MB）
- 部署脚本需要幂等性（重复执行不出错）

---

## PROMPT #5：前端查询历史本地缓存

### 目标文件
- `client/src/hooks/useQueryHistory.ts`（新建）
- `client/src/pages/Home.tsx`（修改，添加历史记录功能）

### 任务描述

在学生端首页添加本地查询历史功能（使用 `localStorage`，无需后端）。

#### `useQueryHistory.ts` 接口

```typescript
interface QueryHistoryItem {
  id: string;
  question: string;
  answer: string;
  sources: QuerySource[];
  createdAt: number; // timestamp
}

export function useQueryHistory() {
  return {
    history: QueryHistoryItem[];          // 最近 20 条记录
    addToHistory: (item: Omit<QueryHistoryItem, 'id' | 'createdAt'>) => void;
    clearHistory: () => void;
    removeFromHistory: (id: string) => void;
  }
}
```

#### 在 `Home.tsx` 中的使用

1. 在问答框下方添加"历史记录"折叠面板（使用 shadcn/ui 的 `Collapsible`）
2. 每次成功查询后，自动将问题和答案保存到历史记录
3. 点击历史记录中的某条，自动填充问题框并显示答案
4. 历史记录最多保存 20 条，超出时删除最旧的

### 关键要求
- 使用 `localStorage` 存储，key 为 `silviculture_query_history`
- 历史记录在组件卸载时不清空（持久化）
- 每条历史记录显示：问题摘要（前 30 字）+ 时间

---

## 注意事项

1. **不要修改以下核心文件**（框架层，避免破坏认证和路由）：
   - `server/_core/` 目录下的所有文件
   - `client/src/lib/trpc.ts`
   - `client/src/contexts/`
   - `drizzle/schema.ts`（除非 PROMPT 明确要求）

2. **提交规范**：
   - `feat: xxx` 新功能
   - `fix: xxx` 修复
   - `refactor: xxx` 重构
   - `test: xxx` 测试

3. **测试要求**：每个 PROMPT 完成后必须运行 `pnpm test` 确保全部通过

4. **类型安全**：所有新增代码必须有完整的 TypeScript 类型，不得使用 `any`
