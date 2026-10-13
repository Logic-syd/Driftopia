# 运行、备份与故障恢复

## 健康与日志

- `GET /api/health`：进程存活，不因为数据库暂时故障重启进程。
- `GET /api/ready`：数据库连接与最低 schema 就绪；Redis 可回退时返回显式 degraded 状态。Docker API healthcheck 使用该接口。
- 请求日志为结构化 JSON，包含 Request ID；追查错误时关联 request ID、响应状态与耗时，不记录 Cookie/密码/完整请求体。
- `GET /api/metrics`：生产需要 bearer `METRICS_TOKEN`，Caddy 对公网始终返回 404；通过内网 Prometheus 获取。
- `docker compose --env-file .env.production -f compose.production.yaml logs --tail 100 api` 查看最近日志；不要把 `.env.production` 或 `docker inspect` 全量结果贴入工单。

## 基础监控

把 `.env.production` 中的 `METRICS_TOKEN` 单独写入权限受限的 `secrets/metrics-token` 文件。Prometheus 容器 UID 65534 必须能只读该文件；使用专用组权限/ACL，避免简单设置世界可读。配置 `METRICS_TOKEN_FILE` 为文件位置，然后：

```bash
docker compose --env-file .env.production -f compose.production.yaml \
  --profile monitoring up -d prometheus
```

Prometheus 只绑定 `127.0.0.1:9090`，通过 SSH tunnel 访问。保留 7 天/最多 512 MB 时序数据，容器内存 256 MB。已提供 API scrape 和 unavailable 告警规则；没有配置外部告警接收者，运营者需要接入自己的 Alertmanager。CPU/RAM/容器重启、磁盘与证书有效期也应由主机监控检查。

## 备份

```bash
bash scripts/backup-db.sh
```

脚本使用 `pg_dump --format=custom` 获得事务一致的逻辑快照，文件权限由 `umask 077` 控制，先写 `.partial`，检查 `pg_restore --list` 成功再原子重命名，最后输出 SHA-256 校验文件。失败不会留下被标记成功的完整备份。默认位置 `backups/`，可设置 `BACKUP_DIR`；备份不包含 Redis，因为缓存可从 PostgreSQL 重建。

安装 `infra/systemd/driftopia-backup.{service,timer}` 可每天 UTC 03:15 左右备份；必须另外将备份及校验文件复制到有加密/访问控制的异地主机或对象存储。**仅在同一主机的 volume/backups 不是灾难恢复。**建议保留每日 14 份、每周 8 份、每月 6 份，验证异地复制后才执行保留策略，仓库脚本不自动删除历史备份。

备份包含邮箱、密码哈希、会话哈希、资产和交易审计等敏感信息，禁止提交 Git 或作为公开 CI artifact。恢复访问权限应限制给运营人员。

## 安全恢复演练

```bash
bash scripts/restore-db.sh backups/<实际备份>.dump restore_drill_20261013
```

备份使用非超级用户 `driftopia_owner`。恢复脚本仅通过 PostgreSQL 容器内的 bootstrap 角色创建新库，实际 restore 使用非超级用户 owner；这些权限不授予 API。恢复脚本强制目标为**新建** `restore_*` 数据库，校验 archive checksum 后，在单事务中 `pg_restore --exit-on-error`；已有目标会被 PostgreSQL 拒绝。运行中的 `driftopia` 数据库不会被覆盖。脚本打印恢复后用户数、成交数、迁移数，再由运营者核对关键资产/幂等日志和最近交易。

每月进行一次恢复演练并记录备份年龄、恢复时长、校验数据规模与问题。若需要正式灾难恢复：先停止 API 写入，保留故障库快照，再在隔离库恢复并验证，最后通过受控数据库名/连接字符串切换上线。切换期间保留维护窗口，检查程序版本与恢复 schema 匹配。不得直接在运行中的库上执行 `pg_restore --clean`。

## 维护与回滚

`infra/systemd/driftopia-maintenance.{service,timer}` 每小时运行生产镜像中的维护脚本，清理过期会话并把过期幂等响应压缩为 tombstone；不会删除可以导致旧请求再次执行的唯一键，也不会清理金融审计或游客资产。

发布时 `scripts/deploy-release.sh` 备份原生产环境文件到权限受限 `backups/environment-*.env`，再原子写入 API/WEB 镜像 digest 并调用 `deploy.sh`。发布失败保留错误退出状态，不伪装为成功；由于数据库可能已前向迁移，不自动尝试逆向恢复。运营者按迁移兼容性决定只回滚镜像、增加修复迁移，或在维护窗口从隔离恢复库切换。

## 本次实际验证记录

本轮在独立 `driftopia-smoke` project / volumes 中执行，未连接开发数据库，也没有公网发布。原始汇总：[deployment-validation.json](deployment-validation.json)。

| 验证            | 实际结果                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生产镜像        | API / Web 两个多阶段镜像成功构建；Node 24.21.0、Prisma 6.19.3，API UID 1000                                                                               |
| 全新数据库      | PostgreSQL 17.11 新卷初始化三个独立角色；非超级用户 owner 成功应用全部 4 项 SQL migration、seed 与应用权限                                                |
| HTTPS 游戏闭环  | `scripts/deploy-smoke.py` 通过，26.02 秒（包含主动退出后的 25 秒等待）；校验真实 Caddy 私有 CA，不关闭证书校验                                            |
| 真实操作        | 两个独立会话注册登录、打捞、建造、排产、离线恢复、交订单、2 × 7 金币交易、相同幂等键重试、双方资产和交易历史、好友、访问、排行榜、真实游客打捞全部成功    |
| 权限边界        | Secure cookie；玩家访问 admin 被拒；API 数据库角色不能 CREATE TABLE、升级 SUPERUSER、读取 `pg_authid` 凭据目录或 DELETE 迁移记录 / 成交记录 / 事件 / 用户 |
| 备份恢复        | 非超级用户 owner 导出归档；校验 SHA-256，恢复到新 `restore_drill_20261013`；4 个用户、1 笔成交，11 张关键表的行数和全部行内容排序哈希均与源库一致         |
| Redis 故障恢复  | 停 Redis 后 readiness 明确 degraded，带会话读取资产成功；重启 Redis 后自动恢复 connected；API 容器 ID、StartedAt 和玩家资产均未变化                       |
| Metrics         | Prometheus 实际 `up{job="driftopia"}=1`；内网无 token 为 401、有 token 为 200，公网反代路径为 404；promtool 验证 3 条告警规则                             |
| 维护 / 重复部署 | 生产镜像 `maintenance --apply` 成功（本次没有过期记录）；再次迁移全部返回 Already applied，seed 和权限脚本成功                                            |

最后 API 镜像仅追加了 `User DELETE` 权限收紧文件层，业务 JavaScript 没有变化；重跑授权并实测拒绝后使用最终镜像 ID 记录。无需重复 25 秒生产周期测试来验证权限文件变化。

测试后已停止隔离服务，保留数据库/恢复库/备份供检查，并释放构建缓存以避免污染后续性能测量。构建中曾遇到 managed Docker `vfs` 大量复制层导致磁盘不足，清理仅可重建的 builder cache 后改为合并重型构建步骤并成功重试；开发卷没有删除。一次并行编辑期间捕获旧测试类型导致 build 失败，修正后的最终冻结源码重新完成 typecheck/build，没有跳过检查。

尚未验证：公开 ACME 证书、真实公网浏览器 Demo（Test F）、远程 GitHub Actions、外部主机 SSH 部署、加密异地备份复制及告警通知送达。用户已确认暂时没有部署服务器/域名，不把本地 HTTPS 验证计为公网部署成功。

安装定时任务时，先核对部署目录为 `/opt/driftopia`、Docker 可执行文件路径和备份磁盘容量，再由主机管理员执行：

```bash
sudo cp infra/systemd/driftopia-*.service infra/systemd/driftopia-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now driftopia-backup.timer driftopia-maintenance.timer
sudo systemctl list-timers 'driftopia-*'
```

修改环境文件中的 PostgreSQL 密码不会自动更新已有卷的数据库角色密码。密码轮换必须先使用数据库 owner/bootstrap 的受控连接执行对应 `ALTER ROLE`，再原子更新受限环境文件并重建相关容器；不要通过删除卷进行密码轮换。
