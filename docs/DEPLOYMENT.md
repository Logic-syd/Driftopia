# 部署方案

当前已验证本地云开发环境与构建产物。未执行公网发布；以下为部署模板，不代表线上实例已经存在。

## 单实例起步

1. 准备 PostgreSQL 17 与 Redis 7，持久化卷；使用独立的生产账号/随机密码及最小数据库权限。
2. 构建镜像：`docker build -f infra/Dockerfile -t driftopia:0.2 .`。
3. 在部署环境注入 `DATABASE_URL`、`REDIS_URL`、`PORT=3001`、`NODE_ENV=production` 和精确的 `WEB_ORIGINS`。
4. 在发布任务中执行 `pnpm db:migrate`，成功后执行 `pnpm db:seed`（不覆盖已有平衡调整）。
5. 启动 API 镜像。将 `dist/web` 部署到静态站点；管理后台 `dist/admin` 放独立受访问控制的域名。
6. Nginx 示例转发 `/api` 和 `/socket.io`。在外层启用 TLS；生产 Cookie 为 Secure，纯 HTTP 无法正常保存登录态。
7. 验证 `/api/health`，然后在隔离的验收数据库运行双玩家 E2E。备份现有库再做正式迁移。

静态资产可从构建容器 `/app/dist/web` 和 `/app/dist/admin` 提取。API 仍需 Prisma client、Node dependencies 和环境变量。Dockerfile 是便于复现的完整镜像，未做生产依赖裁剪。

## 运行约束

- 当前面向单 API 实例。扩容前增加共享限流和 Socket.IO Redis adapter；数据库锁已跨进程有效。
- 数据库是权威来源，Redis 可随时重建。数据库要做每日备份与恢复演练；不要删除 Docker volume 来「修复」安装。
- API 结构化错误日志不包含请求 Cookie/密码。生产需要接入日志聚合、指标与错误追踪服务。
- 反向代理部署需要审查受信任代理/IP 限流设置，不能任意相信客户端转发头。
- 数据归档、账号删除、会话过期主动断开、TLS 证书与恢复流程需要部署方完成。

## CI

`.github/workflows/ci.yml` 在 push/PR 上安装锁定依赖、启动 PostgreSQL/Redis、迁移、seed、lint、typecheck、单测、构建、集成测试、浏览器 E2E，并保存失败 trace。CD 采用手动 `workflow_dispatch` 构建 OCI 镜像并推送 GHCR；不会自动更改线上服务。首次使用需仓库 Actions packages:write 权限，发布前检查工作流中的镜像可见性。
