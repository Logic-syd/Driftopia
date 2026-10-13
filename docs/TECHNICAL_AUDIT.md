# Technical audit — Driftopia v0.2 baseline

审计对象：提交 `53078af`。以源码、实际 PostgreSQL/Redis、HTTP 健康请求和自动化测试为依据；不是 README 功能清单推断。升级中的验证与最终状态另见 `DEVELOPMENT_LOG.md` 和 `VALIDATION.md`，本文件保留初始缺陷，便于核查变化。

## Classification

- **Working**：实现存在且有真实执行证据。
- **Partial**：实现部分存在，或缺少本轮验证/完整生命周期。
- **Missing**：没有实现或没有所需外部资源。
- **Risk**：可能破坏安全、正确性、交付或运行稳定性。

| Area                                      | Baseline classification | Source evidence / observed behavior                                                                                                                                                                            |
| ----------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account + initial base                    | Working                 | `auth.ts register/login/sessionUser`：scrypt、随机会话 token 摘要、注册嵌套创建进度/库存/3×3 基地/漂流物；已有浏览器验收。API 3001 与 PostgreSQL/Redis 当前可达。                                              |
| Salvage, construction, upgrade, expansion | Working / Partial       | `game.ts gameAction` 由服务器查漂流物、坐标、材料和等级；原7个规则测试和21个PG测试覆盖经济核心。升级/扩建有实现，完整浏览器回归尚缺。                                                                          |
| Production + offline                      | Working                 | `production.ts` 和 `game.ts`：时间戳和配方快照持久化，手动3批、自动30批，预扣材料，满仓保留。PG测试覆盖72小时后只结算已排批次、并发不重复收取；现有E2E有刷新恢复，缺真正退出后再登录的测试。                   |
| Orders + level                            | Working                 | 订单模板为静态设计数据，由seed持久化；玩家订单独立快照。领取事务扣库存加金币/XP，去重；优先轮换未见模板。                                                                                                      |
| Player market                             | Working                 | 托管资源、5%向上取整手续费、买卖双方按固定顺序锁、商品行锁、条件扣库存、交易记录原子写入。PG已有2买家竞争，浏览器已有2账号买2个淡水。缺20请求竞争验收。                                                        |
| Friends + visits                          | Partial                 | `main.ts /friends /players/:id/island`：真实DB单向收藏，访问只返回公开建筑/地板。不是双向好友申请；无在线状态，无完整E2E。                                                                                     |
| Rankings                                  | Partial / Risk          | Redis三个sorted sets可重建，数据库回退；`leaderboard()` 每次读取先全表重建，规模增长后会放大数据库和Redis写入；周榜回退排序有旧周分数截断风险。                                                                |
| Stack + boundaries                        | Working / Partial       | TS strict；React19/Vite7/Zustand/Phaser3，Nest11，Prisma6 JS adapter + PG17，Redis7。monorepo按web/admin/api/config/engine/shared/ui划分；API控制器和游戏服务仍偏大，但事务已集中，不需要重写。                |
| Schema + migrations                       | Working                 | `schema.prisma` 的关系模型，3个不可变SQL迁移；自定义迁移器有advisory lock、SHA256和每文件事务。唯一约束、非负库存/余额等CHECK。缺部分查询索引及数据生命周期。                                                  |
| HTTP auth / authorization                 | Working / Risk          | 每请求DB session验证、管理员角色检查、Cookie HttpOnly/Lax/production Secure，写请求Origin检查。同步scrypt阻塞事件循环；生产代理信任链未配置；通用限流按IP使NAT用户互相影响。                                   |
| Idempotency                               | Working / Risk          | `(userId,key)`唯一、事务内请求哈希/返回快照、冲突拒绝。JSON.stringify对key顺序敏感；无清理策略，简单删除又会使旧请求重放成功。提交后的排行DB查询失败可使已提交操作返回错误。                                   |
| WebSocket                                 | Partial / Risk          | Socket.IO握手查session，仅state/market无载荷失效通知。无Origin握手强制验证、注销/过期后撤销连接、连接限额、重连补拉、好友/排行榜通知、事件ID/顺序。私有房间由服务器分配，没有客户端join接口。                  |
| Client state                              | Partial / Risk          | 经济全部调用真实API，未用localStorage模拟经济成功；本地只保存偏好/已读报告。并发refresh可旧响应覆盖新状态；HTTP无超时；connected仅代表上次HTTP成功。                                                           |
| Visual / UX                               | Partial                 | 原创程序绘制海面、建筑、拖拽/缩放和网格；海上装饰船/远岛、日光文案是静态/装饰，非天气或探索系统。打捞点击先淡出而未等服务器，失败时误导。缺音效、昼夜、有效建筑ghost、飞入库存反馈；减动画设置未统一到Phaser。 |
| Loading / error / confirmation            | Partial                 | 注册、生产/交易toast和空状态存在；好友/排行缺完整loading/error/retry；丢弃无确认；重连无明确UI。                                                                                                               |
| Tutorial                                  | Partial                 | 4步真实进度（打捞/建造/生产/订单）；未解释扩建，没有实测5分钟完成率。                                                                                                                                          |
| Tests                                     | Working / Partial       | 7单元、21真实PG集成、3浏览器用例存在；原v0.2验收有31通过记录。本轮在未修改实现前重跑单元/PG/typecheck/lint。缺20并发、故障恢复、HTTP超时重试、WS安全、完整社交和真正退出离线E2E。                              |
| Docker + CI/CD                            | Partial / Risk          | 开发PG/Redis容器healthy；CI模板有PG集成/E2E；镜像模板单阶段root/full dev依赖，未验证整套生产部署。release只是手动构建推GHCR，无quality gate、无实际部署。                                                      |
| Observability + performance               | Missing / Partial       | 仅简单health及未知异常JSON日志，无requestId/metrics/readiness/可重复性能报告。无100/500在线用户测量；不能由单测推导容量。                                                                                      |
| Public demo + operations                  | Missing                 | 当前环境无部署身份、服务器、域名或相关secrets；没有HTTPS公网demo、备份还原演练、正式部署资源上限、guest mode。开发端口不等于上线。                                                                             |

## Real / static / mock distinction

账号、库存、建筑、任务、市场成交、好友收藏、排行榜来源均为真实服务器和数据库。静态建筑配方、资源定义、订单模板是设计配置，不是伪造玩家数据。Phaser绘制的海浪、船只和远岛仅为装饰。测试fixture直接造数据库记录用于隔离测试，不是线上mock repository。没有居民需求、探索海域或合作事件；这些明确推迟。

## Implementation order

1. **P0** 保留现有事务模型，规范幂等哈希/过期后的拒绝重放，降低认证阻塞，补20请求竞争/回滚恢复/IDOR，完整验证12步玩法。
2. **P1** 有限额的真实guest账户；Socket失效通知协议、撤销与重连全量同步；可验证镜像、生产compose、HTTPS/备份/CI质量门禁。公网目标缺资源时明确阻塞，不虚构链接。
3. **P2** 请求日志、requestId、ready/metrics、100/500在线真实测量；据测量和查询证据修复排行榜全表重建、必要索引与连接池；统一UI状态、移动操作和适度场景反馈。
4. **P3** 单向好友在线状态与只读访问完善；双向申请、复杂粒子、多人海域、居民AI继续推迟。

每阶段执行相关真实测试，并在开发记录标明命令、结果和限制。完整商业化经济平衡、跨区域高可用及公网演示验收不能用文档替代。

## Upgrade disposition — v0.3

The table above is the original baseline, not the current release claim. Source changes and executed checks now resolve the following items:

| Current classification | Disposition                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working                | Complete server-persisted loop, upgrades/expansion, genuine logout production recovery, two-account market asset reconciliation, guest accounts, own-listing recovery, friend presence/read-only visits and rankings are exercised by browser tests.                        |
| Working                | Canonical/legacy-compatible idempotency, expired-key tombstones, bounded asynchronous password hashing, strict HTTP/Socket auth, route-alias rate limits, request tracing and metrics have automated checks.                                                                |
| Working                | Real PostgreSQL concurrency and HTTP recovery: 20 buyers for one item, duplicate collection, build/trade and cancel/buy races, response loss, mid-settlement rollback, immediate market cache invalidation; final combined suite is 55/55 passed.                           |
| Working                | Frontend response-body deadlines, same-key retries, refresh coalescing, reconnect resync, duplicate/out-of-order notifications, loading/error/confirmation and five-step tutorial; 14/14 unit plus 8/8 Playwright passed.                                                   |
| Partial                | Production images, strict TLS gameplay, least-privilege roles, backup restore, Redis recovery and Prometheus passed in an isolated deployment (OPERATIONS.md). Local checks do not establish remote GitHub Actions success; hosted status remains unverified after API 403. |
| Partial                | Load runner and 100/500-user measurements exist. Initial 500-user reads saturated; before/after data and exact workload limits are retained in PERFORMANCE.md. This is not a production capacity certification.                                                             |
| Missing                | Public HTTPS demo and acceptance F: user confirmed no server/domain. Remote alert destination, email verification/recovery, bidirectional friend requests and advanced game content remain absent.                                                                          |
| Risk                   | Single-process presence/rate counters/market cache, finite offline queues, unbounded long-term receipt tombstones/audit storage, large Phaser bundle, pg adapter deprecation and unmeasured low-end-device performance remain documented constraints.                       |

Final acceptance statuses are maintained in [VALIDATION.md](VALIDATION.md), production drills in [OPERATIONS.md](OPERATIONS.md), and prioritized remaining work in [ROADMAP.md](ROADMAP.md).
