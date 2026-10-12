# 数据与一致性

数据模型以 `prisma/schema.prisma` 和版本化 SQL 为准。所有经济数值为整数。金额上限通过 Zod 限制，数据库 CHECK 约束防止负余额、非法交易、负库存和自买自卖。

| 模型              | 主键 / 约束                   | 用途                                  |
| ----------------- | ----------------------------- | ------------------------------------- |
| User              | UUID；email 唯一              | 密码摘要、角色                        |
| Session           | tokenHash；user FK            | 7 天登录会话                          |
| PlayerProfile     | userId FK/PK                  | 公开名字（非唯一）                    |
| PlayerProgress    | userId FK/PK                  | 金币、XP、繁荣、新手统计、周积分      |
| Inventory         | userId FK/PK                  | 8 种资源 JSONB，整数非负校验          |
| Island            | UUID；userId 唯一             | 玩家基地                              |
| IslandTile        | UUID；(islandId,x,y) 唯一     | 木筏地板                              |
| Building          | UUID；(islandId,x,y) 唯一     | 建筑位置、类型、等级、autoEnabled     |
| ProductionJob     | UUID；building FK             | 输入输出快照、时刻、状态              |
| SalvageSpawn      | UUID；user FK                 | 服务器生成奖励、到期和领取时间        |
| Order             | code                          | 可管理的订单模板                      |
| PlayerOrder       | UUID；user/order FK           | 订单快照，完成或过期                  |
| MarketListing     | UUID；seller FK               | 托管库存，ACTIVE/SOLD/CANCELLED       |
| MarketTransaction | UUID；listing/buyer/seller FK | 不可变交易流水和手续费                |
| Friendship        | (userId,friendId)             | 单向好友，不允许自己                  |
| GameEvent         | UUID；user FK                 | 操作、金币/库存前后快照；卖家收入流水 |
| IdempotencyRecord | (userId,key)                  | 请求哈希与返回快照                    |
| GameConfigVersion | 自增版本                      | 操作者、scope、配置值与时间           |

## 事务边界

注册嵌套创建玩家、进度、仓库、岛屿、地板与初始漂流物；随后签发会话。建造、生产入队/领取、订单、交易、升级和好友写入均通过统一幂等事务。挂牌先扣资源进入托管；购买转移托管资源；取消退回剩余库存。容量不足时取消失败，商品保持上架。

市场购买的锁顺序固定为排序后的玩家 ID → 商品行。advisory hash 碰撞只会额外串行，不破坏正确性。隔离级别为 PostgreSQL 默认 READ COMMITTED，正确性依赖所有经济写路径持有玩家锁；管理员配置不直接改玩家资源。

## 审计与生命周期

GameEvent 保存玩家经济操作前后库存和金币；市场流水记录买卖双方、金额和手续费。配置版本单独持久化。建造/生产任务引用配置快照，后续调整不追溯改写。

会话 7 天有效，漂流物 180 秒有效，订单 30 分钟有效。MVP 不删除过期历史或幂等记录，避免重放失去依据；生产前需制定归档策略、数据隐私删除流程和查询分页。交易关联阻止简单级联删除玩家，删除用户需显式处理审计留存要求。

主要索引覆盖玩家状态、未领取任务、有效漂流物、有效订单、市场状态+资源+时间、买卖双方交易历史、排行榜和审计时间。迁移额外定义 CHECK 与 JSONB 校验函数，Prisma Schema 不能完整表达这些约束。

## 迁移

`pnpm db:migrate` 执行 `scripts/migrate.ts`，使用 `_driftopia_migrations` 记录文件名、内容 SHA-256 和时间。一次 SQL 文件一个事务；修改已执行文件会拒绝继续，必须新增迁移。不要混用 `prisma migrate deploy` 的迁移历史表。

v0.2 的 `202610120003_automation` 为建筑新增 `autoEnabled`，已有建筑默认关闭；不改历史任务或资源。自动结算事件复用 GameEvent 保存最近收成及库存快照。
