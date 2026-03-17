# 森林培育学智能问答系统 TODO

## 数据库 Schema
- [x] materials 表（教材元数据）
- [x] material_chunks 表（教材内容块 + 向量ID映射）
- [x] queries 表（查询记录 + 引用来源）
- [x] visitor_stats 表（访客统计）
- [x] llm_configs 表（LLM模型配置）
- [x] upload_sessions 表（分块上传会话）
- [x] 数据库迁移推送完成

## 后端核心
- [x] LLM 驱动层（支持 OpenAI / DeepSeek / 通义千问 / Ollama 动态切换）
- [x] Embedding 驱动层（向量化文本）
- [x] 向量检索服务（余弦相似度，MySQL存储向量）
- [x] PDF 处理管道（上传 → 提取文本 → 智能分块 → 向量化 → 存储）
- [x] 大文件分块上传接口（支持 100MB+）
- [x] 问答生成接口（向量检索 Top-5 → LLM 生成 → 引用标注）
- [x] tRPC 路由：materials（教材管理）
- [x] tRPC 路由：qa（问答查询）
- [x] tRPC 路由：stats（访客统计）
- [x] tRPC 路由：llmConfig（模型配置 CRUD）
- [x] 访客地区 IP 解析中间件

## 前端：学生端
- [x] 学生问答主页（搜索框 + 答案展示）
- [x] 答案展示组件（主答案 + 引用来源脚注）
- [x] 加载状态和错误处理
- [x] 页面底部版权信息：'本系统由北京林业大学森林培育学科席本野开发'

## 前端：教师端（需登录 admin 角色）
- [x] 教师仪表板布局（侧边栏导航）
- [x] 教材管理页（上传、列表、删除、处理状态）
- [x] 大文件分块上传组件（进度条）
- [x] 统计仪表板（访客数、地区分布、查询记录、热门问题）
- [x] 热门问题汇总组件
- [x] 教材使用率排行组件
- [x] LLM 模型配置面板（切换驱动、配置 API Key、温度等参数）

## 系统功能
- [x] 权限控制（admin 教师 / user 学生角色分离）
- [x] 全局导航（学生端公开、教师端需登录）

## 测试
- [x] 20个 Vitest 测试全部通过
- [x] Auth 测试（3个）
- [x] QA 问答测试（3个）
- [x] 教材管理测试（4个）
- [x] LLM 配置测试（5个）
- [x] 统计测试（4个）

## 部署 & GitHub
- [ ] 推送代码到 benyexi/silviculture-teaching
- [ ] 保存检查点

## CODEX 协作任务（待分配）
- [ ] PDF文本提取优化（处理扫描件、图片型PDF）
- [ ] 向量检索精度调优（分块策略优化）
- [ ] 答案生成 Prompt 调优（更严格的教材约束）
- [ ] 阿里云服务器 Docker Compose 部署配置

## Bug 修复
- [x] 修复上传完成时 materialId = NaN 的错误（Drizzle mysql2 驱动 insertId 在 result[0] 中，已用 extractInsertId 助手函数修复）
