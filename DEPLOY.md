# Docker Compose 阿里云部署指南

## 1. 服务器准备
- 系统建议：Ubuntu 22.04+
- 安装 Docker 与 Docker Compose
- 放通端口：`22`、`80`、`443`、`3000`（若走 Nginx，外部可只开放 `80/443`）

## 2. 拉取代码
```bash
git clone https://github.com/benyexi/Silviculture-teaching.git
cd Silviculture-teaching
```

## 3. 配置环境变量
在项目根目录创建 `.env`（可先复制 `.env.example`，若无则手动创建）：

```env
# 来自 server/_core/env.ts
VITE_APP_ID=
JWT_SECRET=replace_with_strong_secret
DATABASE_URL=mysql://silviculture:silviculture_password@db:3306/silviculture
OAUTH_SERVER_URL=
OWNER_OPEN_ID=
BUILT_IN_FORGE_API_URL=
BUILT_IN_FORGE_API_KEY=

# docker-compose MySQL 账户（可与 DATABASE_URL 保持一致）
MYSQL_ROOT_PASSWORD=root_password
MYSQL_USER=silviculture
MYSQL_PASSWORD=silviculture_password
```

说明：`DATABASE_URL` 必须使用 Docker 内部网络主机名 `db`，格式如下：

```text
mysql://user:password@db:3306/silviculture
```

## 4. 启动服务
```bash
docker-compose up -d --build
```

查看状态：
```bash
docker-compose ps
docker-compose logs -f app
docker-compose logs -f db
```

## 5. MySQL 初始化步骤
1. 首次启动后等待 `db` 健康检查通过。
2. 进入应用容器执行数据库迁移：

```bash
docker-compose exec app pnpm db:push
```

3. 如需手工检查数据库：

```bash
docker-compose exec db mysql -u$MYSQL_USER -p$MYSQL_PASSWORD silviculture
```

## 6. 一键更新部署
```bash
chmod +x deploy.sh
./deploy.sh
```

## 7. Nginx 反向代理示例
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

建议后续使用 Certbot 配置 HTTPS。
