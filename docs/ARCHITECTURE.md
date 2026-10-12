# 架构

## 边界

`game-config` 只存配置；`game-engine` 为无 I/O 纯规则；`shared` 共享 DTO/Zod Schema。Phaser 只负责绘制、动画和输入，React 管理面板，Zustand 保存服务器状态快照。前端传递建筑/漂流物/订单 ID 和输入意图，不传经济奖励。

API 使用 NestJS 控制器，应用服务负责 Prisma 事务。第一版为单 API 实例设计，PostgreSQL 是唯一经济数据权威来源。Redis 只缓存可重建排行榜，故障时排行榜从数据库查询，经济交易继续工作。

## 并发与幂等

每个玩家经济写入获取事务级 PostgreSQL advisory lock。多玩家交易按用户 ID 排序获取买卖双方锁，再锁定商品行，并条件扣减库存。出售/取消也经过卖家锁，因此取消与购买串行。所有相关金币、库存、交易、审计和幂等记录在同一事务提交。

`Idempotency-Key` 为 UUID。记录以 `(userId, key)` 唯一，包含操作+请求体哈希和响应快照。相同请求重放响应；相同 key 不同请求拒绝。前端遇到网络中断重试一次并复用 key。新点击是新命令。

## 生产

每个任务保存配方输入/输出快照、配置版本、开始与完成时间。入队即扣输入，手动最多三批按顺序执行。自动续产最多预排 30 批。读取私有状态时，在玩家事务锁内收取自动设施已到期的任务，再用当前配方和现有库存续排；新任务从当前时间或现有队尾开始，不追溯模拟离线时间。容量不足保留未收取任务，材料不足不继续预扣。手动领取也按先后顺序收取放得下的批次，满仓时保留其余任务。关闭自动续产后既有任务仍执行，改由手动领取。升级只影响新任务。

不为玩家或建筑启动计时器。唯一周期任务是全局一分钟的排行榜校验/重建（当前适合小规模）。BullMQ 尚无用途，不预先引入。

## 实时与可靠性

Socket.IO 以数据库会话 Cookie 验证，加入用户自己的房间。通知只携带「需要刷新」事件，没有他人私密数据；交易触发市场通知。5 秒轮询用于断线恢复。会话令牌只存 SHA-256，密码用带随机盐的 scrypt。服务端 Origin 检查、SameSite Cookie、限流、Helmet、Zod 和数据库约束叠加保护。

当前 socket 仅发失效通知；生产部署前应加入到期会话主动断开、分布式限流和 Socket.IO Redis adapter。API 日志包含统一错误结构，不记录密码、Cookie 或请求体。

## ORM 与迁移

Prisma 6.19 的正式 JavaScript client engine 使用 `@prisma/adapter-pg`，避免平台原生引擎依赖。CLI 通过 `prisma.config.ts` 的 JavaScript schema engine 生成客户端和 SQL diff（该 CLI 路径为实验特性）。该版本 CLI deploy 在 PostgreSQL 系统 `name` 类型解析上失败，因此迁移执行使用 `pg` 的显式 SQL runner，带独占 advisory lock、SHA-256 校验、事务和迁移表；不关闭任何下载或 TLS 校验。
