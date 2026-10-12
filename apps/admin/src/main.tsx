import React, { useEffect, useState, type FormEvent } from "react";
import ReactDOM from "react-dom/client";
import { Anchor, LogOut, RefreshCw } from "lucide-react";
import { api, ApiError } from "../../web/src/store";
import {
  BUILDINGS,
  RESOURCES,
  type BuildingKind,
} from "../../../packages/game-config/src/index";
import "../../web/src/style.css";
import "./style.css";
interface AdminData {
  players: {
    id: string;
    email: string;
    role: string;
    profile: { name: string };
    progress: { coins: number; xp: number; prosperity: number };
  }[];
  transactions: {
    id: string;
    resource: string;
    quantity: number;
    total: number;
    fee: number;
    createdAt: string;
  }[];
  versions: {
    id: number;
    actorId: string;
    scope: string;
    value: unknown;
    createdAt: string;
  }[];
  orders: { code: string; name: string; coins: number; xp: number }[];
  total: { _count: number; _sum: { coins: number; orders: number } };
  anomalies: { id: string }[];
}
function Admin() {
  const [data, setData] = useState<AdminData | null>(null),
    [status, setStatus] = useState(""),
    [access, setAccess] = useState(false),
    [tab, setTab] = useState("players"),
    [kind, setKind] = useState<BuildingKind>("purifier"),
    [recipe, setRecipe] = useState(
      JSON.stringify(BUILDINGS.purifier.recipe, null, 2),
    ),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setData(await api<AdminData>("/admin"));
      setAccess(true);
    } catch (e) {
      setStatus(
        e instanceof ApiError && e.status === 403
          ? "当前账号没有管理员权限。请在服务器设置 ADMIN_EMAIL 后运行 pnpm db:seed。"
          : e instanceof Error
            ? e.message
            : "连接失败",
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(
        "/auth/login",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }
  async function save(body: unknown) {
    setBusy(true);
    try {
      await api("/admin/config", body);
      setStatus(
        "配置已保存并审计。新任务使用新配方，正在进行的任务保持原快照。",
      );
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-app">
      <header>
        <div className="admin-brand">
          <Anchor />
          <strong>Driftopia</strong>
          <span>岛屿管理局</span>
        </div>
        {access && (
          <button
            className="secondary"
            onClick={async () => {
              await api("/auth/logout", {});
              setAccess(false);
              setData(null);
            }}
          >
            <LogOut size={14} />
            退出
          </button>
        )}
      </header>
      {!access ? (
        <main className="admin-login">
          <div className="eyebrow">THE ISLAND OFFICE</div>
          <h1>管理你创造的世界</h1>
          <p>仅限经过授权的管理员账号</p>
          <form onSubmit={login}>
            <label>
              邮箱
              <input name="email" type="email" required />
            </label>
            <label>
              密码
              <input name="password" type="password" required />
            </label>
            <button className="primary full" disabled={busy}>
              登录管理后台
            </button>
          </form>
          <p className="form-error" role="alert">
            {status}
          </p>
        </main>
      ) : (
        data && (
          <main className="admin-main">
            <div className="admin-title">
              <div>
                <div className="eyebrow">ECONOMY & COMMUNITY</div>
                <h1>今天的群岛</h1>
              </div>
              <button className="secondary" onClick={() => void load()}>
                <RefreshCw size={15} />
                刷新
              </button>
            </div>
            <div className="admin-metrics">
              {[
                [data.total._count, "注册漂流者"],
                [data.total._sum.coins ?? 0, "流通金币"],
                [data.total._sum.orders ?? 0, "完成委托"],
                [data.anomalies.length, "异常交易（基础规则）"],
              ].map(([value, label]) => (
                <div key={label}>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <div className="tabs">
              {[
                ["players", "玩家"],
                ["config", "资源与配方"],
                ["orders", "委托奖励"],
                ["market", "交易流水"],
                ["audit", "配置审计"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={tab === id ? "active" : ""}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {status && (
              <div className="notice" role="status">
                {status}
              </div>
            )}
            {tab === "players" && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>漂流者</th>
                      <th>邮箱</th>
                      <th>金币</th>
                      <th>经验</th>
                      <th>繁荣</th>
                      <th>权限</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.players.map((p) => (
                      <tr key={p.id}>
                        <td>{p.profile.name}</td>
                        <td>{p.email}</td>
                        <td>{p.progress.coins}</td>
                        <td>{p.progress.xp}</td>
                        <td>{p.progress.prosperity}</td>
                        <td>{p.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === "config" && (
              <>
                <div className="admin-resources">
                  {Object.entries(RESOURCES).map(([id, r]) => (
                    <span key={id}>
                      {r.icon} {r.name} <code>{id}</code>
                    </span>
                  ))}
                </div>
                <div className="admin-editor">
                  <label>
                    生产设施
                    <select
                      value={kind}
                      onChange={(e) => {
                        const value = e.target.value as BuildingKind;
                        setKind(value);
                        setRecipe(
                          JSON.stringify(
                            data.versions.find(
                              (v) => v.scope === `recipe:${value}`,
                            )?.value ?? BUILDINGS[value].recipe,
                            null,
                            2,
                          ),
                        );
                      }}
                    >
                      {Object.entries(BUILDINGS)
                        .filter(([, b]) => b.recipe)
                        .map(([id, b]) => (
                          <option key={id} value={id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    配方（整数数量，秒）
                    <textarea
                      value={recipe}
                      onChange={(e) => setRecipe(e.target.value)}
                      rows={13}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      try {
                        void save({
                          type: "recipe",
                          kind,
                          recipe: JSON.parse(recipe),
                        });
                      } catch {
                        setStatus("请输入合法 JSON");
                      }
                    }}
                  >
                    校验并发布新版本
                  </button>
                </div>
                <p className="panel-note">
                  生产时长范围 3–86400 秒。配方资源上限
                  100；所有校验和管理员权限由服务端再次验证。
                </p>
              </>
            )}
            {tab === "orders" &&
              data.orders.map((o) => (
                <form
                  className="admin-order"
                  key={o.code}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void save({
                      type: "order",
                      code: o.code,
                      coins: Number(f.get("coins")),
                      xp: Number(f.get("xp")),
                    });
                  }}
                >
                  <strong>{o.name}</strong>
                  <label>
                    金币
                    <input
                      name="coins"
                      type="number"
                      min={1}
                      max={10000}
                      defaultValue={o.coins}
                    />
                  </label>
                  <label>
                    经验
                    <input
                      name="xp"
                      type="number"
                      min={1}
                      max={1000}
                      defaultValue={o.xp}
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    保存
                  </button>
                </form>
              ))}
            {tab === "market" && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>交易 ID</th>
                      <th>资源</th>
                      <th>数量</th>
                      <th>总额</th>
                      <th>手续费</th>
                      <th>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.transactions.map((t) => (
                      <tr key={t.id}>
                        <td>{t.id.slice(0, 8)}</td>
                        <td>{t.resource}</td>
                        <td>{t.quantity}</td>
                        <td>{t.total}</td>
                        <td>{t.fee}</td>
                        <td>{new Date(t.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === "audit" && (
              <>
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await api("/admin/rebuild-rankings", {});
                      setStatus("Redis 排行榜已从 PostgreSQL 重建");
                    } catch (e) {
                      setStatus(e instanceof Error ? e.message : "重建失败");
                    }
                  }}
                >
                  从数据库重建排行榜
                </button>
                {data.versions.map((v) => (
                  <article className="audit-entry" key={v.id}>
                    <strong>
                      v{v.id} · {v.scope}
                    </strong>
                    <small>
                      {new Date(v.createdAt).toLocaleString()} · {v.actorId}
                    </small>
                    <pre>{JSON.stringify(v.value, null, 2)}</pre>
                  </article>
                ))}
              </>
            )}
          </main>
        )
      )}
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Admin />
  </React.StrictMode>,
);
