# API v0.2

前缀 `/api`，JSON 请求/响应，Cookie `driftopia_session`。所有游戏/市场/好友/配置写入需 UUID `Idempotency-Key`。重复请求须复用 key 与完全相同请求体。错误统一为 `{ "error": { "code": "...", "message": "..." } }`。

| 方法 | 路径                         | 输入 / 用途                                                    |
| ---- | ---------------------------- | -------------------------------------------------------------- |
| GET  | /health                      | PostgreSQL 与 Redis 实际连通性                                 |
| POST | /auth/register               | email, password(8–128), name(2–20)                             |
| POST | /auth/login                  | email, password                                                |
| POST | /auth/logout                 | 撤销当前会话                                                   |
| GET  | /state                       | 私有存档、服务器时间、可领产出                                 |
| POST | /game/salvage                | spawnId                                                        |
| POST | /game/build                  | kind, x, y                                                     |
| POST | /game/expand                 | x, y（邻接现有地板，±8）                                       |
| POST | /game/move                   | buildingId, x, y                                               |
| POST | /game/upgrade                | buildingId                                                     |
| POST | /game/automation             | buildingId, enabled(boolean)；开启/关闭自动续产                |
| POST | /game/produce                | buildingId                                                     |
| POST | /game/collect                | buildingId                                                     |
| POST | /game/order                  | orderId                                                        |
| GET  | /market?resource=wood        | 最多 100 笔有效商品                                            |
| POST | /market                      | resource, quantity(1–100), unitPrice(1–10000)                  |
| POST | /market/:id/buy              | quantity(1–100)；界面选择数量并显示总价                        |
| POST | /market/:id/cancel           | 空对象                                                         |
| GET  | /market/history              | 当前玩家最近 50 笔交易                                         |
| GET  | /players?q=                  | 名称搜索，最多 40 位公开玩家                                   |
| GET  | /players/:id/island          | 只读基地；不返回金币、仓库、任务或邮箱                         |
| GET  | /friends                     | 好友与公开资料                                                 |
| POST | /friends/:id                 | 空对象，单向添加                                               |
| GET  | /leaderboard?type=prosperity | prosperity / xp / weeklyPoints，前 20                          |
| GET  | /admin                       | 管理员数据汇总；普通用户 403                                   |
| POST | /admin/config                | type=recipe + kind + recipe，或 type=order + code + coins + xp |
| POST | /admin/rebuild-rankings      | 从 PostgreSQL 重建 Redis                                       |

无登录返回 401，权限不足 403，输入无效 400，经济冲突 409，限流 429。Nest POST 成功默认 201。不同用户看不到彼此私有库存或生产任务；客户端提交的 reward 字段不会用于结算。

实时连接 `/socket.io` 使用相同会话；事件 `state:changed` 和 `market:changed` 表示客户端应重新读取状态，不包含权威经济增量。登录限流 10 次/分钟/IP，其余 240 次/分钟/IP（单实例）。

仓库整理：`POST /game/discard`，参数 `resource` 和 `quantity`（1–10000 整数）；只影响当前玩家库存，不奖励金币，受相同事务和幂等约束。

自动生产：`GET /state` 在玩家事务锁内结算已完成的自动任务，并返回建筑 `autoEnabled`、`autoStatus`（`off/running/warehouse_full/materials`）、当前有效 `recipe` 和最近一次 `productionReport`（id、batches、resources、createdAt）。报告为已入库结果，读取或关闭报告不会再次发放资源。前端按账号在本地保存已读报告 ID。`production:auto` 与 `production:scheduled` 事件记录库存前后快照。开启自动后禁止手动追加任务，关闭不退回已预扣材料、不取消既有任务。自动与手动领取均保留仓库放不下的批次。
