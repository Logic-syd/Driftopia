# 开发与启动

## 准备

根目录 Node.js 24、pnpm 11.25.0。仓库所有 package 清单由根依赖/锁文件统一管理；各 workspace 包用于模块边界，当前使用相对 TS imports，无预编译共享包步骤。

参考 README 按顺序启动依赖、生成 Prisma client、迁移、seed。`.env.example` 仅提供本地容器开发值，不应用作公网生产凭据。已有 `.env` 不会被 setup 脚本覆盖。无需外部 API 密钥。

## 服务

`pnpm dev` 同时启动 API 3001、Web 5173、Admin 5174。前端代理 `/api` 和 `/socket.io`，Cookie 保持同源。首次注册后正常游玩，无「假数据模式」。Docker 只启动 PostgreSQL 和 Redis，避免前端开发热更新依赖镜像重建。

`GET /api/health` 检查进程存活；检查 `GET /api/ready` 应显示 database、schema、redis 就绪；前端注册完成后会加载实际基地。Redis 是可降级缓存，数据库断开则不允许经济操作。

云任务进程不保证快照恢复。新任务先 `docker compose up -d --wait`，再确认 `.env` 和依赖，必要时运行 `bash scripts/setup-cloud.sh`；启动 `pnpm dev` 并检查健康响应。已经有目标进程时复用它，避免端口冲突。每个云任务独立，不创建额外 worktree。

## 常用开发命令

- `pnpm typecheck` / `pnpm lint` / `pnpm test`
- `pnpm test:integration`：需要 API 和 PostgreSQL/Redis，真实事务测试，清理仅自己创建的数据。迁移回归会创建/删除独立临时数据库，测试角色需 `CREATEDB`；开发/CI Compose 的角色已具备，生产 API 角色不应具备。
- `pnpm test:e2e`：需要 web 和 API，真实浏览器流程；系统 Chromium 用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定。
- `pnpm build`：严格类型检查后构建三个应用。
- `pnpm start:api`：运行构建产物。
- `pnpm economy`：纯 TS 确定性经济模拟，不修改数据库。
- `pnpm economy:phase3`：三人群/五种子/五时间点的探索经济模型，含有限离线队列与资源账本；结果与假设见 ECONOMY_BALANCE_REPORT.md。
- `pnpm format`：统一格式。

## 数据模型变更

修改 Prisma Schema，使用 JS schema engine 生成 SQL：

```sh
pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script
```

该命令的 from-migrations 路径可能需要 shadow database；简单改动也可以手写新增 `prisma/migrations/<timestamp>_<name>/migration.sql`。审阅后执行 `pnpm db:migrate` 和 `pnpm db:generate`。不要编辑已执行的迁移，不要用 `db push` 覆盖测试或已有数据。自定义 SQL CHECK 约束需保留。

## 管理员

注册独立账号，在服务器环境设置 `ADMIN_EMAIL` 为其邮箱后 `pnpm db:seed`。后台沿用 Cookie 会话。普通用户请求 `/api/admin` 和配置写入得到 403。无预置管理密码；seed 未匹配到账号会显示分配 0 人，先检查账号是否已注册。

## 故障记录

Prisma 原生引擎域名在此云环境未开放。已采用官方 PrismaPg + JS client/schema engine，生成过程不下载原生引擎且保留 npm 完整性校验。Prisma 6.19 实验 JS migration deploy 对系统 name 类型解析失败，故使用受版本控制的 SQL 与 `pg` 事务迁移 runner。无需将 `binaries.prisma.sh` 加入网络白名单。

## Portfolio upgrade operations

`pnpm maintenance` 只读报告过期会话/回执，`pnpm maintenance -- --apply` 分批删除过期会话、压缩回执结果并保留幂等键摘要。`pnpm perf` 使用独立500/100用户fixture进行真实HTTP和Socket负载，先阅读 PERFORMANCE.md，勿对未授权实例运行。生产配置/备份见 DEPLOYMENT.md、OPERATIONS.md。
