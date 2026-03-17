# Docker Compose 阿里云部署指南

## 1. 服务器准备

- 系统建议：Ubuntu 22.04+
- 安装 Docker 与 Docker Compose（`apt install docker.io docker-compose-plugin -y`）
- 放通端口：`22`、`80`、`443`、`3000`（若走 Nginx，外部可只开放 `80/443`）

## 2. 拉取代码

```bash
git clone https://github.com/benyexi/Silviculture-teaching.git
cd Silviculture-teaching
```

## 3. 配置环境变量

在项目根目录创建 `.env` 文件：

```env
# ── MySQL 账户 ──────────────────────────────────────────────
MYSQL_ROOT_PASSWORD=replace_with_strong_root_password
MYSQL_USER=silviculture
MYSQL_PASSWORD=replace_with_strong_password

# ── 应用数据库连接（使用 Docker 内部网络主机名 db）──────────
DATABASE_URL=mysql://silviculture:replace_with_strong_password@db:3306/silviculture

# ── Manus OAuth（必填，从 Manus 平台获取）──────────────────
VITE_APP_ID=
JWT_SECRET=replace_with_strong_random_secret
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://manus.im

# ── 项目所有者信息（从 Manus 平台获取）─────────────────────
OWNER_OPEN_ID=
OWNER_NAME=

# ── Manus Forge API（LLM / 存储 / 通知，从 Manus 平台获取）─
BUILT_IN_FORGE_API_URL=
BUILT_IN_FORGE_API_KEY=
VITE_FRONTEND_FORGE_API_URL=
VITE_FRONTEND_FORGE_API_KEY=

# ── 前端应用信息（可选）────────────────────────────────────
VITE_APP_TITLE=森林培育学知识问答系统
```

> **重要**：`DATABASE_URL` 必须使用 Docker 内部网络主机名 `db`，不能写 `localhost`。

## 4. 首次启动

```bash
# 构建镜像并启动所有服务（后台运行）
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

如需手工检查数据库：

```bash
docker compose exec db mysql -u$MYSQL_USER -p$MYSQL_PASSWORD silviculture
```

## 6. 一键更新部署

后续更新代码后，执行：

```bash
chmod +x deploy.sh
./deploy.sh
```

脚本会自动执行：`git pull` → `docker compose down` → `docker compose up -d --build`。

## 7. Nginx 反向代理（推荐）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 大文件上传支持（教材 PDF 最大 200MB）
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

建议后续使用 Certbot 配置 HTTPS：

```bash
apt install certbot python3-certbot-nginx -y
certbot --nginx -d your-domain.com
```

## 8. 健康检查端点

应用提供 `/healthz` 端点，返回 `{"status":"ok"}`，可用于负载均衡器或监控系统。

## 9. 常用运维命令

```bash
# 查看所有服务状态
docker compose ps

# 实时查看应用日志
docker compose logs -f app

# 重启应用（不重建镜像）
docker compose restart app

# 进入应用容器
docker compose exec app sh

# 停止所有服务
docker compose down

# 停止并删除数据卷（⚠️ 会清空数据库）
docker compose down -v
```
