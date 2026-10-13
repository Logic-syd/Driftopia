import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Anchor,
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  Compass,
  Flag,
  Hammer,
  Leaf,
  LogOut,
  Map,
  Plus,
  Settings,
  Ship,
  ShoppingBag,
  Sparkles,
  Trophy,
  Users,
  Waves,
  X,
} from "lucide-react";
import { io } from "socket.io-client";
import { Ocean } from "./Ocean";
import {
  api,
  clearSession,
  useGame,
  type Panel,
  type SyncTopic,
} from "./store";
import { createSyncGate, type SyncNotice } from "./realtime";
import { reducedMotion, playFeedback } from "./feedback";
import {
  BUILDINGS,
  ECONOMY,
  RESOURCES,
  RESOURCE_IDS,
  type BuildingKind,
  type Bundle,
  type Resource,
} from "../../../packages/game-config/src/index";
import {
  count,
  productionSeconds,
  upgradeCost,
} from "../../../packages/game-engine/src/index";
import type {
  ListingView,
  PlayerState,
  PublicPlayer,
} from "../../../packages/shared/src/index";
import { compactNumber, remaining } from "../../../packages/ui/src/index";
function useClock() {
  const [time, setTime] = useState(Date.now());
  const offset = useGame((s) => s.offset);
  useEffect(() => {
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return time + offset;
}
function ResourceCost({ bundle, stock }: { bundle: Bundle; stock?: Bundle }) {
  return (
    <span className="resource-cost">
      {Object.entries(bundle).map(([id, n]) => (
        <span
          key={id}
          className={
            stock && (stock[id as Resource] ?? 0) < n ? "insufficient" : ""
          }
        >
          {RESOURCES[id as Resource].icon} {n}
          <small>{RESOURCES[id as Resource].name}</small>
        </span>
      ))}
    </span>
  );
}
function Modal({
  title,
  kicker,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  kicker?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const modalRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() =>
      modalRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const controls = Array.from(
          modalRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ) ?? [],
        );
        const first = controls[0],
          last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-head">
          <div>
            <div className="eyebrow">{kicker ?? "LIFE AT SEA"}</div>
            <h2>{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭面板"
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  );
}
function Auth() {
  const [mode, setMode] = useState<"register" | "login">("register"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [guestEnabled, setGuestEnabled] = useState(false);
  useEffect(() => {
    void api<{ guestEnabled: boolean }>("/auth/options")
      .then((o) => setGuestEnabled(o.guestEnabled))
      .catch(() => {});
  }, []);
  async function guest() {
    setBusy(true);
    setError("");
    try {
      await api("/auth/guest", {});
      await useGame.getState().refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "体验小岛暂时无法靠岸");
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(`/auth/${mode}`, data);
      await useGame.getState().refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-wrap">
      <section className="auth-card">
        <div className="auth-emblem">
          <Anchor size={32} />
        </div>
        <div className="eyebrow">A LITTLE RAFT. A BIG NEW WORLD.</div>
        <h1>
          让生活，
          <br />
          慢慢漂向美好。
        </h1>
        <p>
          从一块小小的木筏开始，
          <br />
          建造属于你的海上乌托邦。
        </p>
        <div className="auth-tabs">
          <button
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            开启漂流
          </button>
          <button
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            回到我的岛
          </button>
        </div>
        <form onSubmit={submit}>
          {mode === "register" && (
            <label>
              漂流者昵称
              <input
                name="name"
                placeholder="你想被怎样称呼？"
                minLength={2}
                maxLength={20}
                required
                autoComplete="nickname"
              />
            </label>
          )}
          <label>
            邮箱
            <input
              name="email"
              type="email"
              placeholder="hello@ocean.com"
              required
              autoComplete="email"
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              placeholder="至少 8 个字符"
              minLength={8}
              maxLength={128}
              required
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy
              ? "正在靠岸…"
              : mode === "register"
                ? "出发，去海上生活"
                : "欢迎回到你的岛"}
            <ArrowRight size={17} />
          </button>
        </form>
        {guestEnabled && (
          <div className="guest-entry">
            <button
              className="secondary full"
              disabled={busy}
              onClick={() => void guest()}
            >
              免注册体验小岛 · 24 小时
            </button>
            <p>
              创建独立的真实小岛，正常参与生产与交易。请使用同一浏览器返回。
            </p>
          </div>
        )}
        <div className="auth-foot">
          <Leaf size={13} /> 随心建造 · 慢慢生长 · 一起漂流
        </div>
      </section>
    </div>
  );
}
function Guide({ state }: { state: PlayerState }) {
  const tasks = [
    {
      done: state.stats.salvaged > 0,
      title: "捞起海上的第一份礼物",
      text: "点击海面上的漂流木或漂流瓶",
      panel: null,
    },
    {
      done: state.buildings.some((b) => b.kind === "purifier"),
      title: "造一座净水器",
      text: "让海水变成生活的第一份补给",
      panel: "build" as Panel,
    },
    {
      done: state.stats.produced > 0,
      title: "收获第一批淡水",
      text: "点击净水器，开始生产并收取",
      panel: null,
    },
    {
      done: state.stats.orders > 0,
      title: "完成第一笔商船委托",
      text: "给远航的人一杯水，换取金币",
      panel: "orders" as Panel,
    },
    {
      done: state.tiles.length > 9,
      title: "给新生活多留一格空间",
      text: "扩建木筏，给仓库和交易码头留位置。仓库增加容量，码头连接其他玩家。",
      panel: "build" as Panel,
    },
  ];
  const index = tasks.findIndex((t) => !t.done);
  const task = tasks[index];
  return (
    <aside className="guide-card">
      <div className="guide-title">
        <span className="mini-icon">
          <Flag size={16} />
        </span>
        <span>漂流手记 · 约 5 分钟</span>
        <small>
          {index === -1 ? tasks.length : index}/{tasks.length}
        </small>
      </div>
      <div className="guide-progress">
        {tasks.map((t, i) => (
          <span key={i} className={t.done ? "complete" : ""} />
        ))}
      </div>
      <span className="chapter">
        {index === -1 ? "下一站 · 海上邻里" : `第一章 · 海上的新生活`}
      </span>
      <h3>{task?.title ?? "让小小的岛，连接世界"}</h3>
      <p>{task?.text ?? "建造交易码头，和其他漂流者做一笔生意。"}</p>
      <button
        className="text-button"
        onClick={() => {
          if (task?.panel) useGame.getState().setPanel(task.panel);
          else if (index === 2) {
            const b = state.buildings.find((b) => b.kind === "purifier");
            if (b) useGame.setState({ selected: b.id });
          } else if (index === -1) useGame.getState().setPanel("market");
          else
            useGame
              .getState()
              .notify("点击漂流物即可打捞，也可使用下方的快捷打捞按钮");
        }}
      >
        {index === -1 ? "看看海上集市" : "开始这一小步"}
        <ArrowRight size={14} />
      </button>
    </aside>
  );
}
function BuildPanel({ state }: { state: PlayerState }) {
  return (
    <>
      <p className="panel-intro">
        一块木板，一间小屋。把海上的日子，过成喜欢的模样。
      </p>
      <div className="building-grid">
        {(
          Object.entries(BUILDINGS) as [
            BuildingKind,
            (typeof BUILDINGS)[BuildingKind],
          ][]
        ).map(([id, b]) => (
          <button
            className="building-card"
            key={id}
            disabled={state.level < b.unlock}
            data-testid={`build-${id}`}
            onClick={() =>
              useGame.setState({ panel: null, placement: { kind: id } })
            }
          >
            <span className={`building-art ${id}`}>
              <span>{b.icon}</span>
              <i />
              <i />
            </span>
            <span className="building-info">
              <span className="building-name">
                {b.name}
                <small>
                  {state.level < b.unlock
                    ? `Lv.${b.unlock} 解锁`
                    : `繁荣 +${b.prosperity}`}
                </small>
              </span>
              <span className="building-desc">{b.description}</span>
              <ResourceCost bundle={b.cost} stock={state.inventory} />
              <span className="coin-cost">◈ {b.coins} 金币</span>
            </span>
          </button>
        ))}
      </div>
      <button
        className="expand-card"
        onClick={() =>
          useGame.setState({ panel: null, placement: { kind: "floor" } })
        }
      >
        <span>
          <Plus size={20} /> 扩建木筏地板
        </span>
        <ResourceCost bundle={ECONOMY.floorCost} stock={state.inventory} />
        <ArrowRight size={18} />
      </button>
      <details className="accessible-placement">
        <summary>使用坐标选择建造位置</summary>
        <CoordinateBuild state={state} />
      </details>
    </>
  );
}
function CoordinateBuild({ state }: { state: PlayerState }) {
  const busy = useGame((s) => s.busy);
  const [kind, setKind] = useState<BuildingKind | "floor">("purifier");
  const expansion = state.tiles
    .flatMap((t) =>
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy })),
    )
    .filter(
      (t, i, all) =>
        Math.abs(t.x) <= 8 &&
        Math.abs(t.y) <= 8 &&
        !state.tiles.some((p) => p.x === t.x && p.y === t.y) &&
        all.findIndex((p) => p.x === t.x && p.y === t.y) === i,
    );
  return (
    <div className="coordinate-build">
      <label>
        建筑
        <select
          aria-label="建筑"
          value={kind}
          onChange={(e) => setKind(e.target.value as BuildingKind | "floor")}
        >
          <option value="floor">扩建木筏地板</option>
          {Object.entries(BUILDINGS)
            .filter(([, b]) => b.unlock <= state.level)
            .map(([id, b]) => (
              <option key={id} value={id}>
                {b.name}
              </option>
            ))}
        </select>
      </label>
      <div className="tile-buttons">
        {(kind === "floor" ? expansion : state.tiles)
          .filter(
            (t) => !state.buildings.some((b) => b.x === t.x && b.y === t.y),
          )
          .map((t) => (
            <button
              disabled={busy}
              key={`${t.x},${t.y}`}
              onClick={() =>
                void useGame
                  .getState()
                  .action(kind === "floor" ? "/game/expand" : "/game/build", {
                    ...(kind === "floor" ? {} : { kind }),
                    ...t,
                  })
              }
            >
              在 ({t.x}, {t.y}) {kind === "floor" ? "扩建" : "建造"}
            </button>
          ))}
      </div>
    </div>
  );
}
function Inventory({ state }: { state: PlayerState }) {
  const [resource, setResource] = useState<Resource>("plastic");
  const [quantity, setQuantity] = useState(1);
  const [confirmation, setConfirmation] = useState<{
    resource: Resource;
    quantity: number;
  } | null>(null);
  const busy = useGame((s) => s.busy);
  return (
    <>
      <div className="inventory-summary">
        <Box size={30} />
        <div>
          <strong>
            {count(state.inventory)} <span>/ {state.capacity}</span>
          </strong>
          <p>每一份资源，都是海的馈赠</p>
        </div>
      </div>
      <div className="inventory-grid">
        {RESOURCE_IDS.map((id) => (
          <div className="inventory-item" key={id}>
            <span>{RESOURCES[id].icon}</span>
            <strong>{state.inventory[id] ?? 0}</strong>
            <small>{RESOURCES[id].name}</small>
          </div>
        ))}
      </div>
      <p className="panel-note">
        建造或升级仓库可增加容量。市场挂牌中的资源已托管，不占用仓库。
      </p>
      <details className="accessible-placement">
        <summary>整理仓库 · 丢弃多余资源</summary>
        <form
          className="discard-form"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirmation({ resource, quantity });
          }}
        >
          <label>
            资源
            <select
              aria-label="丢弃资源"
              value={resource}
              onChange={(e) => setResource(e.target.value as Resource)}
            >
              {RESOURCE_IDS.map((id) => (
                <option key={id} value={id}>
                  {RESOURCES[id].name}
                </option>
              ))}
            </select>
          </label>
          <label>
            数量
            <input
              aria-label="丢弃数量"
              type="number"
              min={1}
              max={state.inventory[resource] ?? 0}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </label>
          <button
            className="secondary"
            disabled={
              busy ||
              !(state.inventory[resource] ?? 0) ||
              !Number.isInteger(quantity) ||
              quantity < 1 ||
              quantity > (state.inventory[resource] ?? 0)
            }
          >
            丢弃 {quantity} 个
          </button>
        </form>
        <p className="panel-note">
          丢弃不会获得金币，操作后无法找回。可用于腾出紧急打捞空间。
        </p>
      </details>
      {confirmation && (
        <div
          className="confirm-card"
          role="alertdialog"
          aria-label="确认丢弃资源"
        >
          <h3>
            丢弃 {confirmation.quantity} 个
            {RESOURCES[confirmation.resource].name}？
          </h3>
          <p>
            资源将永久移除，也不会获得金币。你也可以通过委托或集市腾出空间。
          </p>
          <div className="confirm-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              保留资源
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                if (
                  await useGame.getState().action("/game/discard", confirmation)
                )
                  setConfirmation(null);
              }}
            >
              {busy ? "正在整理…" : "确认永久丢弃"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
function Orders({ state }: { state: PlayerState }) {
  const now = useClock();
  return (
    <>
      <div className="panel-banner">
        <Ship size={34} />
        <div>
          <h3>远方的商船，带来了新消息</h3>
          <p>交付补给，获得金币与漂流经验。</p>
        </div>
      </div>
      <div className="order-list">
        {state.orders.map((o) => (
          <article className="order-card" key={o.id}>
            <div className="order-head">
              <span className="order-stamp">⛵</span>
              <div>
                <small>{o.description}</small>
                <h3>{o.name}</h3>
              </div>
              <span className="time-label">{remaining(o.expiresAt, now)}</span>
            </div>
            <ResourceCost bundle={o.input} stock={state.inventory} />
            <div className="order-bottom">
              <span>
                <b>◈ {o.coins}</b>
                <small>✧ {o.xp} 经验</small>
              </span>
              <button
                className="primary"
                disabled={
                  useGame.getState().busy ||
                  Object.entries(o.input).some(
                    ([r, n]) => (state.inventory[r as Resource] ?? 0) < n,
                  )
                }
                onClick={() =>
                  void useGame
                    .getState()
                    .action("/game/order", { orderId: o.id })
                }
              >
                交付委托
                <ArrowRight size={15} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
function Production({ state, id }: { state: PlayerState; id: string }) {
  const [expanded, setExpanded] = useState(false);
  const b = state.buildings.find((b) => b.id === id),
    now = useClock(),
    busy = useGame((s) => s.busy);
  if (!b) return null;
  const cfg = BUILDINGS[b.kind],
    recipe = b.recipe,
    ready = b.jobs.filter((j) => Date.parse(j.finishesAt) <= now).length;
  return (
    <Modal
      title={cfg.name}
      kicker={`YOUR LITTLE ISLAND · LEVEL ${b.level}`}
      onClose={() => useGame.setState({ selected: null })}
    >
      <div className={`production-hero building-art ${b.kind}`}>
        <span>{cfg.icon}</span>
      </div>
      <p className="panel-intro">{cfg.description}</p>
      {recipe && (
        <>
          <div className="recipe-line">
            {Object.keys(recipe.input).length ? (
              <ResourceCost bundle={recipe.input} stock={state.inventory} />
            ) : (
              <span>🌊 海洋的馈赠</span>
            )}
            <ArrowRight size={18} />
            <ResourceCost bundle={recipe.output} />
          </div>
          <p className="panel-note">
            当前配方 · 每批 {productionSeconds(b.kind, b.level, recipe.seconds)}{" "}
            秒。已排任务保留原配方。队列 {b.jobs.length}/
            {b.autoEnabled || b.jobs.length > ECONOMY.queueLimit
              ? ECONOMY.autoQueueLimit
              : ECONOMY.queueLimit}
          </p>
          <div className="auto-mode">
            <label>
              <span>
                <strong>自动续产</strong>
                <small>自动收取 · 预排最多 30 批</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label="自动续产"
                checked={b.autoEnabled}
                disabled={busy}
                onChange={(e) =>
                  void useGame.getState().action("/game/automation", {
                    buildingId: id,
                    enabled: e.target.checked,
                  })
                }
              />
            </label>
            <p className="auto-status">
              {
                {
                  off: "手动安排，按你的节奏来",
                  running: "自动续产已开启",
                  warehouse_full: "仓库空间不足 · 腾出空间后自动继续",
                  materials: "材料不足 · 补充后自动继续",
                }[b.autoStatus]
              }
            </p>
            <p className="panel-note">
              开启时预扣队列材料。离线只完成已排任务，回来后收取并续排；关闭后已排任务继续，产出需手动收取。
            </p>
          </div>
          <div className="job-list">
            {(expanded ? b.jobs : b.jobs.slice(0, 3)).map((j, i) => (
              <div className="job" key={j.id}>
                <span>
                  {Date.parse(j.finishesAt) <= now ? (
                    <Check size={16} />
                  ) : (
                    <span className="spinner-dot" />
                  )}
                  {Date.parse(j.finishesAt) <= now
                    ? "可以收获"
                    : Date.parse(j.startsAt) > now
                      ? `排队中 · 第 ${i + 1} 批`
                      : "正在生产"}
                </span>
                <ResourceCost bundle={j.output} />
                <b>{remaining(j.finishesAt, now)}</b>
              </div>
            ))}
          </div>
          {b.jobs.length > 3 && (
            <button
              className="text-button queue-toggle"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? "收起队列"
                : `查看全部 ${b.jobs.length} 批 · 最后一批 ${remaining(b.jobs.at(-1)!.finishesAt, now)}`}
            </button>
          )}
          <div className="button-row">
            <button
              className="primary"
              disabled={
                busy || b.autoEnabled || b.jobs.length >= ECONOMY.queueLimit
              }
              onClick={() =>
                void useGame
                  .getState()
                  .action("/game/produce", { buildingId: id })
              }
            >
              开始生产
            </button>
            <button
              className="secondary"
              disabled={busy || !ready}
              onClick={() =>
                void useGame
                  .getState()
                  .action("/game/collect", { buildingId: id })
              }
            >
              收取产出 {ready > 0 ? `(${ready})` : ""}
            </button>
          </div>
        </>
      )}
      <div className="upgrade-box">
        <h4>
          让它变得更好{" "}
          <span>
            Lv.{b.level} → Lv.{Math.min(3, b.level + 1)}
          </span>
        </h4>
        <ResourceCost
          bundle={upgradeCost(b.kind, b.level)}
          stock={state.inventory}
        />
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy || b.level >= 3}
            onClick={() =>
              void useGame
                .getState()
                .action("/game/upgrade", { buildingId: id })
            }
          >
            {b.level >= 3 ? "已达最高等级" : `升级 · ${30 * b.level} 金币`}
          </button>
          <button
            className="text-button"
            onClick={() =>
              useGame.setState({
                selected: null,
                placement: { kind: b.kind, movingId: id },
              })
            }
          >
            移动位置
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </Modal>
  );
}
interface HistoryItem {
  id: string;
  buyerId: string;
  resource: Resource;
  quantity: number;
  total: number;
  fee: number;
  createdAt: string;
}
function MarketRow({
  listing: l,
  state,
  dock,
  reload,
}: {
  listing: ListingView;
  state: PlayerState;
  dock: boolean;
  reload: () => void;
}) {
  const [amount, setAmount] = useState(1),
    busy = useGame((s) => s.busy);
  const own = l.sellerId === state.id;
  const maximum = Math.max(
    0,
    Math.min(
      100,
      l.quantity,
      Math.floor(state.coins / l.unitPrice),
      state.capacity - count(state.inventory),
    ),
  );
  const quantity = Math.min(amount, Math.max(1, maximum));
  return (
    <div className="market-row">
      <span className="market-resource">{RESOURCES[l.resource].icon}</span>
      <div>
        <h4>
          {RESOURCES[l.resource].name}
          <small>× {l.quantity}</small>
        </h4>
        <p>
          {l.seller.profile.name}
          {own ? " · 我的商品" : ""}
        </p>
      </div>
      <div className="market-price">
        <strong>◈ {l.unitPrice}</strong>
        <small>金币 / 个</small>
      </div>
      <div className="market-purchase">
        {!own && (
          <label>
            <span className="sr-only">
              购买{RESOURCES[l.resource].name}数量
            </span>
            <input
              aria-label={`购买${RESOURCES[l.resource].name}数量`}
              type="number"
              min={1}
              max={Math.max(1, maximum)}
              value={quantity}
              disabled={busy || !dock || !maximum}
              onChange={(e) =>
                setAmount(
                  Math.max(
                    1,
                    Math.min(maximum, Math.floor(Number(e.target.value) || 1)),
                  ),
                )
              }
            />
            <small>合计 ◈ {quantity * l.unitPrice}</small>
          </label>
        )}
        <button
          className={own ? "secondary" : "primary"}
          disabled={busy || !dock || (!own && !maximum)}
          onClick={async () => {
            await useGame
              .getState()
              .action(
                `/market/${l.id}/${own ? "cancel" : "buy"}`,
                own ? {} : { quantity },
              );
            reload();
          }}
        >
          {own ? "下架" : maximum ? `购买 ${quantity} 个` : "金币或仓容不足"}
        </button>
      </div>
    </div>
  );
}
function ProductionNotice({ state }: { state: PlayerState }) {
  const key = `driftopia:production-report:${state.id}`;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(key));
  const report = state.productionReport;
  if (!report || report.id === dismissed) return null;
  return (
    <aside className="production-notice" aria-label="自动生产收成">
      <span className="harvest-icon">🌱</span>
      <div>
        <strong>小岛替你忙了一会儿</strong>
        <p>最近自动入库 {report.batches} 批</p>
        <ResourceCost bundle={report.resources} />
      </div>
      <button
        className="icon-button"
        aria-label="收起生产收成"
        onClick={() => {
          localStorage.setItem(key, report.id);
          setDismissed(report.id);
        }}
      >
        <X size={16} />
      </button>
    </aside>
  );
}
function Market({ state }: { state: PlayerState }) {
  const [list, setList] = useState<ListingView[]>([]),
    [filter, setFilter] = useState(""),
    [tab, setTab] = useState<"browse" | "mine" | "sell" | "history">("browse"),
    [history, setHistory] = useState<HistoryItem[]>([]),
    [resource, setResource] = useState<Resource>("wood"),
    [quantity, setQuantity] = useState(1),
    [price, setPrice] = useState(3),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    busy = useGame((s) => s.busy);
  const revision = useGame((s) => s.revisions.market);
  const requestVersion = useRef(0);
  const dock = state.buildings.some((b) => b.kind === "dock");
  const reload = () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    Promise.all([
      api<ListingView[]>(
        `/market?${new URLSearchParams({ ...(filter ? { resource: filter } : {}), ...(tab === "mine" ? { mine: "true" } : {}) })}`,
      ),
      api<HistoryItem[]>("/market/history"),
    ])
      .then(([l, h]) => {
        if (version !== requestVersion.current) return;
        setList(l);
        setHistory(h);
      })
      .catch((e) => {
        if (version === requestVersion.current) setError(e.message);
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  };
  useEffect(() => {
    reload();
    const t = setInterval(reload, 8000);
    return () => {
      clearInterval(t);
      requestVersion.current++;
    };
  }, [filter, tab, revision]);
  async function sell(e: FormEvent) {
    e.preventDefault();
    if (
      await useGame
        .getState()
        .action("/market", { resource, quantity, unitPrice: price })
    ) {
      setTab("mine");
      reload();
    }
  }
  return (
    <>
      <div className="panel-banner">
        <ShoppingBag size={34} />
        <div>
          <h3>交换所需，也遇见彼此</h3>
          <p>真实玩家交易 · 成交向卖家收取 5% 手续费</p>
        </div>
      </div>
      {!dock && (
        <div className="notice">
          建造「交易码头」后即可买卖。你现在可以浏览市场。
        </div>
      )}
      <div className="tabs">
        {(
          [
            ["browse", "海上集市"],
            ["mine", "我的挂牌"],
            ["sell", "我要出售"],
            ["history", "交易记录"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="fetch-error" role="alert">
          {error}
          <button className="text-button" onClick={reload}>
            重试加载市场
          </button>
        </div>
      )}
      {loading && (
        <p className="loading-note" aria-live="polite">
          正在同步集市…
        </p>
      )}
      {(tab === "browse" || tab === "mine") && (
        <>
          <label className="filter">
            筛选资源
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">所有资源</option>
              {RESOURCE_IDS.map((id) => (
                <option value={id} key={id}>
                  {RESOURCES[id].name}
                </option>
              ))}
            </select>
            <span>{list.length} 笔在售</span>
          </label>
          {!list.length ? (
            <Empty
              icon={<Ship size={38} />}
              title={
                error
                  ? "集市暂时无法靠岸"
                  : loading
                    ? "商船正在靠岸…"
                    : tab === "mine"
                      ? "你还没有在售商品"
                      : "海上集市还很安静"
              }
              text="第一笔生意，或许就从你开始。"
            />
          ) : (
            <div className="market-list">
              {list.map((l) => (
                <MarketRow
                  key={l.id}
                  listing={l}
                  state={state}
                  dock={dock}
                  reload={reload}
                />
              ))}
            </div>
          )}
        </>
      )}
      {tab === "sell" && (
        <form className="sell-form" onSubmit={sell}>
          <label>
            出售资源
            <select
              aria-label="出售资源"
              value={resource}
              onChange={(e) => setResource(e.target.value as Resource)}
            >
              {RESOURCE_IDS.map((id) => (
                <option key={id} value={id}>
                  {RESOURCES[id].name} · 拥有 {state.inventory[id] ?? 0}
                </option>
              ))}
            </select>
          </label>
          <div className="form-columns">
            <label>
              数量
              <input
                type="number"
                min={1}
                max={Math.min(100, state.inventory[resource] ?? 0)}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                required
              />
            </label>
            <label>
              单价（金币）
              <input
                type="number"
                min={1}
                max={10000}
                value={price}
                onChange={(e) => setPrice(Number(e.target.value))}
                required
              />
            </label>
          </div>
          <p className="panel-note">
            上架时资源将托管到市场。逐笔成交扣除向上取整的 5%
            手续费；全部一次售出预计收到{" "}
            {quantity * price - Math.ceil(quantity * price * 0.05)} 金币。
          </p>
          <button className="primary full" disabled={busy || !dock}>
            挂牌出售
            <ArrowRight size={16} />
          </button>
        </form>
      )}
      {tab === "history" &&
        (!history.length ? (
          <Empty
            icon={<Box size={36} />}
            title={
              loading
                ? "正在读取交易记录…"
                : error
                  ? "交易记录暂时无法读取"
                  : "还没有成交记录"
            }
            text="你的每一笔交易，都会被好好记住。"
          />
        ) : (
          history.map((h) => (
            <div className="market-row" key={h.id}>
              <span className="market-resource">
                {RESOURCES[h.resource].icon}
              </span>
              <div>
                <h4>
                  {h.buyerId === state.id ? "买入" : "卖出"}{" "}
                  {RESOURCES[h.resource].name} × {h.quantity}
                </h4>
                <p>{new Date(h.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <b>
                {h.buyerId === state.id ? `−${h.total}` : `+${h.total - h.fee}`}{" "}
                ◈
              </b>
            </div>
          ))
        ))}
    </>
  );
}
function Empty({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
interface Visit {
  id: string;
  profile: { name: string };
  progress: { xp: number; prosperity: number };
  island: {
    tiles: { x: number; y: number }[];
    buildings: {
      id: string;
      kind: BuildingKind;
      x: number;
      y: number;
      level: number;
    }[];
  };
}
function Friends({ state }: { state: PlayerState }) {
  const [query, setQuery] = useState(""),
    [players, setPlayers] = useState<(PublicPlayer & { online?: boolean })[]>(
      [],
    ),
    [friendIds, setFriendIds] = useState<string[]>([]),
    [visit, setVisit] = useState<Visit | null>(null),
    [onlyFriends, setOnlyFriends] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0),
    [visiting, setVisiting] = useState<string | null>(null);
  const revision = useGame((s) => s.revisions.friends);
  const busy = useGame((s) => s.busy);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      void Promise.all([
        api<PublicPlayer[]>(`/players?q=${encodeURIComponent(query)}`),
        api<{ friendId: string }[]>("/friends"),
      ])
        .then(([p, f]) => {
          if (live) {
            setPlayers(p.filter((p) => p.id !== state.id));
            setFriendIds(f.map((f) => f.friendId));
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, state.id, revision, retry]);
  if (visit)
    return (
      <>
        <button className="text-button" onClick={() => setVisit(null)}>
          ← 回到漂流者列表
        </button>
        <div className="visit-header">
          <span>🏝️</span>
          <h3>{visit.profile.name}的漂浮小岛</h3>
          <p>繁荣度 {visit.progress.prosperity} · 只读访问</p>
        </div>
        <div className="visit-island">
          {visit.island.tiles.map((t) => {
            const b = visit.island.buildings.find(
              (b) => b.x === t.x && b.y === t.y,
            );
            return (
              <div
                className="visit-tile"
                key={`${t.x},${t.y}`}
                style={{
                  left: `calc(50% + ${(t.x - t.y) * 32}px)`,
                  top: `calc(50% + ${(t.x + t.y) * 17}px)`,
                }}
              >
                {b && (
                  <span title={`${BUILDINGS[b.kind].name} Lv.${b.level}`}>
                    {BUILDINGS[b.kind].icon}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="visit-buildings">
          {visit.island.buildings.map((b) => (
            <span key={b.id}>
              {BUILDINGS[b.kind].icon} {BUILDINGS[b.kind].name} Lv.{b.level}
            </span>
          ))}
        </div>
      </>
    );
  return (
    <>
      <div className="tabs">
        <button
          className={!onlyFriends ? "active" : ""}
          onClick={() => setOnlyFriends(false)}
        >
          发现漂流者
        </button>
        <button
          className={onlyFriends ? "active" : ""}
          onClick={() => setOnlyFriends(true)}
        >
          我的好友 · {friendIds.length}
        </button>
      </div>
      <input
        className="search"
        aria-label="搜索漂流者"
        placeholder="搜索漂流者的名字…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && (
        <p className="loading-note" aria-live="polite">
          正在寻找海上邻里…
        </p>
      )}
      {error && (
        <div className="fetch-error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => setRetry((n) => n + 1)}
          >
            重试加载好友
          </button>
        </div>
      )}
      {players
        .filter((p) => !onlyFriends || friendIds.includes(p.id))
        .map((p) => (
          <div className="player-row" key={p.id}>
            <span className="avatar">{p.name.slice(0, 1)}</span>
            <div>
              <h4>{p.name}</h4>
              <p>
                Lv.{p.level} · 繁荣度 {p.prosperity} ·{" "}
                {p.online ? "正在岛上" : "暂时离岛"}
              </p>
            </div>
            <button
              className="text-button"
              disabled={visiting !== null}
              onClick={async () => {
                setVisiting(p.id);
                try {
                  setVisit(await api<Visit>(`/players/${p.id}/island`));
                } catch (e) {
                  useGame
                    .getState()
                    .notify(
                      e instanceof Error ? e.message : "访问失败",
                      "error",
                    );
                } finally {
                  setVisiting(null);
                }
              }}
            >
              {visiting === p.id ? "靠岸中…" : "访问"}
            </button>
            <button
              className="secondary"
              disabled={busy || friendIds.includes(p.id)}
              onClick={async () => {
                if (await useGame.getState().action(`/friends/${p.id}`, {}))
                  setFriendIds([...friendIds, p.id]);
              }}
            >
              {friendIds.includes(p.id) ? "已添加" : "+ 好友"}
            </button>
          </div>
        ))}
      {!loading &&
        !error &&
        !players.filter((p) => !onlyFriends || friendIds.includes(p.id))
          .length && (
          <Empty
            icon={<Users size={38} />}
            title="海风会带来新的朋友"
            text="邀请另一位玩家注册，就可以发现彼此的岛屿。"
          />
        )}
    </>
  );
}
function Ranking() {
  const [type, setType] = useState<"prosperity" | "xp" | "weeklyPoints">(
      "prosperity",
    ),
    [players, setPlayers] = useState<PublicPlayer[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  const revision = useGame((s) => s.revisions.leaderboard);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void api<PublicPlayer[]>(`/leaderboard?type=${type}`)
      .then((players) => {
        if (live) setPlayers(players);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [type, revision, retry]);
  return (
    <>
      <div className="tabs">
        {(
          [
            ["prosperity", "岛屿繁荣"],
            ["xp", "漂流等级"],
            ["weeklyPoints", "本周委托"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={type === id ? "active" : ""}
            onClick={() => setType(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {loading && (
        <p className="loading-note" aria-live="polite">
          正在读取群岛排名…
        </p>
      )}
      {error && (
        <div className="fetch-error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => setRetry((n) => n + 1)}
          >
            重试加载排行榜
          </button>
        </div>
      )}
      {!loading && !error && !players.length && (
        <Empty
          icon={<Trophy size={38} />}
          title="群岛的新故事正在开始"
          text="完成建造和委托，让你的岛屿登上榜单。"
        />
      )}
      {players.map((p, i) => (
        <div className="player-row" key={p.id}>
          <span className={`rank-number rank-${i}`}>
            {i < 3 ? ["🥇", "🥈", "🥉"][i] : String(i + 1).padStart(2, "0")}
          </span>
          <span className="avatar">{p.name.slice(0, 1)}</span>
          <div>
            <h4>{p.name}</h4>
            <p>漂流者 Lv.{p.level}</p>
          </div>
          <strong className="rank-score">
            {type === "xp" ? `Lv.${p.level}` : p[type]}
          </strong>
        </div>
      ))}
      <p className="panel-note">本周委托积分每周一 UTC 00:00 开始新一轮。</p>
    </>
  );
}
function Profile({ state }: { state: PlayerState }) {
  return (
    <>
      <div className="profile-hero">
        <span className="avatar large">{state.name.slice(0, 1)}</span>
        <h3>{state.name}</h3>
        <p>海风群岛 · 漂流者 Lv.{state.level}</p>
      </div>
      <div className="profile-stats">
        <div>
          <strong>{state.prosperity}</strong>
          <span>岛屿繁荣</span>
        </div>
        <div>
          <strong>{state.tiles.length}</strong>
          <span>木筏地板</span>
        </div>
        <div>
          <strong>{state.buildings.length}</strong>
          <span>建筑设施</span>
        </div>
        <div>
          <strong>{state.stats.orders}</strong>
          <span>完成委托</span>
        </div>
      </div>
      <p className="panel-note">
        进度实时保存到云端，重新登录即可继续这段海上的生活。
      </p>
    </>
  );
}
function Preferences() {
  const [reduced, setReduced] = useState(reducedMotion());
  const [sound, setSound] = useState(
    localStorage.getItem("driftopia-sound") === "on",
  );
  const [loggingOut, setLoggingOut] = useState(false);
  return (
    <>
      <div className="setting-row">
        <div>
          <h3>减少界面动画</h3>
          <p>同时关闭海浪、建筑浮动与镜头缓动</p>
        </div>
        <input
          aria-label="减少界面动画"
          type="checkbox"
          checked={reduced}
          onChange={(e) => {
            setReduced(e.target.checked);
            localStorage.setItem(
              "driftopia-motion",
              e.target.checked ? "reduced" : "full",
            );
            document.documentElement.classList.toggle(
              "reduce-motion",
              e.target.checked,
            );
          }}
        />
      </div>
      <div className="setting-row">
        <div>
          <h3>轻柔操作音效</h3>
          <p>打捞与成功操作时的一点回响，默认关闭</p>
        </div>
        <input
          aria-label="轻柔操作音效"
          type="checkbox"
          checked={sound}
          onChange={(e) => {
            setSound(e.target.checked);
            localStorage.setItem(
              "driftopia-sound",
              e.target.checked ? "on" : "off",
            );
            if (e.target.checked) playFeedback("success");
          }}
        />
      </div>
      <div className="setting-row">
        <div>
          <h3>操作方式</h3>
          <p>
            点击打捞和建筑 · 拖动海面平移
            <br />
            滚轮或双指缩放 · Esc 关闭面板
          </p>
        </div>
        <Compass size={30} />
      </div>
      <button
        className="secondary full"
        disabled={loggingOut}
        onClick={async () => {
          setLoggingOut(true);
          try {
            await api("/auth/logout", {});
            clearSession();
          } catch (error) {
            useGame
              .getState()
              .notify(
                error instanceof Error ? error.message : "退出失败，请重试",
                "error",
              );
          } finally {
            setLoggingOut(false);
          }
        }}
      >
        <LogOut size={16} /> {loggingOut ? "正在安全离岛…" : "暂别小岛"}
      </button>
      <p className="panel-note">Driftopia v0.3 · 原创多人海上生存经营</p>
    </>
  );
}
const panels: Record<
  Exclude<Panel, null>,
  { title: string; kicker: string }
> = {
  build: { title: "一起造点什么", kicker: "BUILD YOUR LITTLE WORLD" },
  inventory: { title: "我的仓库", kicker: "GIFTS FROM THE OCEAN" },
  orders: { title: "商船委托", kicker: "LET GOOD THINGS SET SAIL" },
  market: { title: "海上集市", kicker: "TRADE A LITTLE. CONNECT A LOT." },
  friends: { title: "海上邻里", kicker: "NO ISLAND IS ALONE" },
  ranking: { title: "群岛风云榜", kicker: "GROW TOGETHER" },
  settings: { title: "慢生活设置", kicker: "MAKE YOURSELF AT HOME" },
  profile: { title: "漂流者档案", kicker: "YOUR STORY AT SEA" },
};
export default function App() {
  const {
    state,
    loading,
    panel,
    selected,
    toast,
    toastKind,
    placement,
    busy,
    connected,
    socketStatus,
    syncError,
    syncing,
  } = useGame();
  const now = useClock();
  useEffect(() => {
    const refresh = () => void useGame.getState().refresh();
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) refresh();
    }, 10000);
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const online = () => {
      useGame
        .getState()
        .invalidate(["state", "market", "friends", "leaderboard"]);
    };
    const offline = () =>
      useGame.setState({
        connected: false,
        socketStatus: "offline",
        syncError: "网络已离线，已保存的进度会在重连后同步。",
      });
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  useEffect(() => {
    if (!state?.id) return;
    const socket = io({ withCredentials: true, reconnectionDelayMax: 5000 });
    const gate = createSyncGate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<SyncTopic>();
    const enqueue = (topics: SyncTopic[]) => {
      topics.forEach((topic) => pending.add(topic));
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        useGame.getState().invalidate([...pending]);
        pending.clear();
      }, 100);
    };
    const resync = () => enqueue(["state", "market", "friends", "leaderboard"]);
    socket.on("connect", () => {
      useGame.setState({ socketStatus: "connected" });
      resync();
    });
    socket.on("sync:ready", (message: { epoch: string; sequence: number }) => {
      gate.ready(message);
      resync();
    });
    socket.on("sync:invalidate", (message: SyncNotice) =>
      enqueue(gate.accept(message)),
    );
    socket.on("disconnect", () =>
      useGame.setState({
        socketStatus: navigator.onLine ? "reconnecting" : "offline",
      }),
    );
    socket.on("connect_error", () =>
      useGame.setState({
        socketStatus: navigator.onLine ? "reconnecting" : "offline",
      }),
    );
    socket.on("session:expired", () => {
      clearSession();
      useGame.getState().notify("登录已到期，请重新靠岸", "error");
    });
    return () => {
      if (timer) clearTimeout(timer);
      socket.disconnect();
    };
  }, [state?.id]);
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reducedMotion());
  }, []);
  const nav = [
    { id: "build", label: "建造", icon: Hammer },
    { id: "inventory", label: "仓库", icon: Box },
    { id: "orders", label: "委托", icon: Ship },
    { id: "market", label: "集市", icon: ShoppingBag },
    { id: "friends", label: "好友", icon: Users },
    { id: "ranking", label: "排行", icon: Trophy },
  ] as const;
  return (
    <div className="app-shell">
      <Ocean />
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Waves size={28} />
          </span>
          <div>
            <strong>
              Driftopia<span>漂流乌托邦</span>
            </strong>
            <small>A SLOWER LIFE, AN OPEN SEA.</small>
          </div>
        </div>
        {state ? (
          <>
            <div className="resource-bar">
              {(["wood", "plastic", "water"] as const).map((id) => (
                <button
                  key={id}
                  onClick={() => useGame.getState().setPanel("inventory")}
                  title={RESOURCES[id].name}
                >
                  <span>{RESOURCES[id].icon}</span>
                  <strong>{compactNumber(state.inventory[id] ?? 0)}</strong>
                  <small>{RESOURCES[id].name}</small>
                </button>
              ))}
              <button
                className="coins"
                onClick={() => useGame.getState().setPanel("orders")}
              >
                <span>◈</span>
                <strong>{compactNumber(state.coins)}</strong>
                <small>金币</small>
              </button>
            </div>
            <button
              className="player-chip"
              onClick={() => useGame.getState().setPanel("profile")}
            >
              <span className="avatar">{state.name.slice(0, 1)}</span>
              <span>
                <strong>{state.name}</strong>
                <small>漂流者 Lv.{state.level}</small>
              </span>
              <ChevronRight size={16} />
            </button>
            <button
              className="icon-button settings-button"
              aria-label="设置"
              onClick={() => useGame.getState().setPanel("settings")}
            >
              <Settings size={20} />
            </button>
          </>
        ) : (
          <span className="edition">
            THE FIRST VOYAGE <span>／</span> v0.3
          </span>
        )}
      </header>
      {loading ? (
        <div className="loading-card">
          <Anchor className="loading-anchor" />
          <p>正在寻找你的海岸…</p>
        </div>
      ) : !state ? (
        <>
          <Auth />
          {syncError && (
            <div className="connection-banner" role="alert">
              {syncError}
              <button
                disabled={syncing}
                onClick={() => void useGame.getState().refresh()}
              >
                重新连接
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {(syncError || socketStatus !== "connected") && (
            <div className="connection-banner" role="alert">
              <span>{syncError ?? "实时连接恢复中，进度仍会定期同步。"}</span>
              <button
                disabled={syncing || !navigator.onLine}
                onClick={() => void useGame.getState().refresh()}
              >
                {syncing ? "同步中…" : "重新同步"}
              </button>
            </div>
          )}
          {state.isGuest && (
            <div className="guest-banner">
              体验小岛 · 剩余{" "}
              {Math.max(
                0,
                Math.ceil(
                  (Date.parse(state.guestExpiresAt ?? "") - now) / 3600000,
                ),
              )}{" "}
              小时 · 同一浏览器可返回，退出登录后无法找回
            </div>
          )}
          <div className="world-title">
            <div className="eyebrow">
              <span className="live-dot" /> 海风群岛 · 宁静海域
            </div>
            <h1>
              {state.name}的漂浮小岛<span>✧</span>
            </h1>
            <p>
              <span>{Math.floor(now / 240000) % 2 === 0 ? "☀" : "☾"}</span>{" "}
              {Math.floor(now / 240000) % 2 === 0
                ? "海面染上晨光，适合开启新的旅程。"
                : "星光落在海面，小岛仍在慢慢生长。"}
            </p>
            <div className="world-badges">
              <span>
                <Leaf size={13} /> 繁荣度 {state.prosperity}
              </span>
              <button onClick={() => useGame.getState().setPanel("inventory")}>
                <Box size={13} /> {count(state.inventory)} / {state.capacity}
              </button>
            </div>
          </div>
          <Guide state={state} />
          <ProductionNotice key={state.id} state={state} />
          <div className="island-label">
            <Anchor size={12} /> MY LITTLE DRIFTOPIA
          </div>
          <aside className="daily-card">
            <span className="daily-art">☀</span>
            <div>
              <span className="eyebrow">A NOTE FROM THE OCEAN</span>
              <p>
                不必急着抵达，
                <br />
                这里，也可以是家。
              </p>
              <small>海风来信 · Vol. 01</small>
            </div>
          </aside>
          <div className="production-peek">
            <div className="peek-title">
              <span>
                <Sparkles size={15} /> 岛上的小忙碌
              </span>
              <small>{state.buildings.length} 座设施</small>
            </div>
            {state.buildings.length ? (
              state.buildings.slice(0, 3).map((b) => (
                <button
                  key={b.id}
                  onClick={() =>
                    useGame.setState({ selected: b.id, panel: null })
                  }
                >
                  <span>{BUILDINGS[b.kind].icon}</span>
                  <div>
                    <strong>{BUILDINGS[b.kind].name}</strong>
                    <small>
                      {b.jobs.length
                        ? Date.parse(b.jobs[0].finishesAt) <= now
                          ? "收获已准备好"
                          : `生产中 · ${remaining(b.jobs[0].finishesAt, now)}`
                        : BUILDINGS[b.kind].recipe
                          ? "等待你的安排"
                          : "正在为小岛出一份力"}
                    </small>
                  </div>
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <p>
                第一座建筑，会是什么模样？
                <button
                  className="text-button"
                  onClick={() => useGame.getState().setPanel("build")}
                >
                  开始建造 <ArrowRight size={13} />
                </button>
              </p>
            )}
          </div>
          <div className="salvage-shortcut">
            <button
              disabled={!state.salvage.length || busy}
              onClick={() =>
                void useGame
                  .getState()
                  .action("/game/salvage", { spawnId: state.salvage[0]?.id })
              }
            >
              <Anchor size={17} /> 快捷打捞 <span>{state.salvage.length}</span>
            </button>
            <small>也可以直接点击海面漂流物</small>
          </div>
          <nav className="bottom-nav" aria-label="游戏导航">
            {nav.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={panel === id ? "active" : ""}
                onClick={() =>
                  useGame.getState().setPanel(panel === id ? null : id)
                }
              >
                <Icon size={23} strokeWidth={1.6} />
                <span>{label}</span>
                {id === "orders" &&
                  state.orders.some((o) =>
                    Object.entries(o.input).every(
                      ([r, n]) => (state.inventory[r as Resource] ?? 0) >= n,
                    ),
                  ) && <i />}
              </button>
            ))}
          </nav>
          <div className="world-footer">
            <span>
              <Map size={13} /> 一方木筏，万种可能。
            </span>
            <span className="save-status">
              <span className="live-dot" />{" "}
              {!connected
                ? "等待同步"
                : socketStatus === "connected"
                  ? "云端已同步 · 实时连接"
                  : "云端已同步 · 定时更新"}
            </span>
          </div>
          {panel && (
            <Modal
              title={panels[panel].title}
              kicker={panels[panel].kicker}
              wide={["build", "market", "friends"].includes(panel)}
              onClose={() => useGame.getState().setPanel(null)}
            >
              {panel === "build" ? (
                <BuildPanel state={state} />
              ) : panel === "inventory" ? (
                <Inventory state={state} />
              ) : panel === "orders" ? (
                <Orders state={state} />
              ) : panel === "market" ? (
                <Market state={state} />
              ) : panel === "friends" ? (
                <Friends state={state} />
              ) : panel === "ranking" ? (
                <Ranking />
              ) : panel === "profile" ? (
                <Profile state={state} />
              ) : (
                <Preferences />
              )}
            </Modal>
          )}
          {selected && <Production state={state} id={selected} />}
        </>
      )}
      {toast && (
        <div
          className={`toast ${toastKind === "error" ? "toast-error" : ""}`}
          role="status"
        >
          <span>
            {toastKind === "error" ? <X size={16} /> : <Check size={16} />}
          </span>
          {toast}
        </div>
      )}
      {placement && (
        <div className="build-mode-pill">
          <Hammer size={13} /> 建造模式
        </div>
      )}
    </div>
  );
}
