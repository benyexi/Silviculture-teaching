# 阿里云 Docker Compose 部署指南

## 1. 服务器准备

- 系统建议：Ubuntu 22.04+ 或 CentOS 8+
- 安装 Docker 与 Docker Compose：
  ```bash
  # Ubuntu
  apt update && apt install docker.io docker-compose-plugin -y
  systemctl enable docker && systemctl start docker
  ```
- 安全组放通端口：`22`、`80`、`443`、`3000`

## 2. 拉取代码

```bash
git clone https://github.com/benyexi/Silviculture-teaching.git
cd Silviculture-teaching
```

## 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，**必须修改以下项**：

```env
MYSQL_ROOT_PASSWORD=你的强密码
MYSQL_PASSWORD=你的强密码
DATABASE_URL=mysql://silviculture:你的强密码@db:3306/silviculture
JWT_SECRET=至少32字符的随机字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的管理员密码
```

> **重要**：`DATABASE_URL` 中的密码必须与 `MYSQL_PASSWORD` 一致，主机名必须是 `db`（Docker 内部网络）。

## 4. 首次启动

```bash
# 构建镜像并启动所有服务
docker compose up -d --build

# 查看启动状态
docker compose ps
docker compose logs -f app
```

## 5. 数据库初始化

首次启动后，等待 `db` 服务健康检查通过，然后执行数据库迁移：

```bash
docker compose exec app pnpm db:push
```

## 6. 访问系统

- **学生端**（无需登录）：`http://你的服务器IP:3000`
- **教师端**：`http://你的服务器IP:3000/login`，用 ADMIN_USERNAME / ADMIN_PASSWORD 登录

## 7. 配置 LLM 模型（必须）

登录教师后台后，进入「模型配置」页面：
1. 点击「添加配置」
2. 选择 LLM 提供商（推荐 DeepSeek，国内访问快）
3. 填写模型名称和 API Key
4. 点击「激活」

支持的提供商：
- **DeepSeek**：`deepseek-chat`，Base URL 自动填充
- **OpenAI**：`gpt-4o-mini` 等
- **通义千问**：`qwen-plus` 等
- **Ollama**：本地部署，无需 API Key

## 8. 上传教材

登录教师后台 → 教材管理 → 上传 PDF 教材

## 9. 一键更新部署

```bash
chmod +x deploy.sh
./deploy.sh
```

## 10. Nginx 反向代理（推荐）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 200m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

配置 HTTPS：

```bash
apt install certbot python3-certbot-nginx -y
certbot --nginx -d your-domain.com
```

## 11. 常用运维命令

```bash
docker compose ps              # 查看服务状态
docker compose logs -f app     # 实时查看应用日志
docker compose restart app     # 重启应用
docker compose exec app sh     # 进入应用容器
docker compose down            # 停止所有服务
docker compose down -v         # 停止并删除数据卷（⚠️ 会清空数据库和上传文件）
```
