import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Anchor,
  ArrowRight,
  Check,
  Compass,
  Flag,
  LockKeyhole,
  Map,
  PackageCheck,
  Sailboat,
  Shield,
  Sparkles,
  Waves,
  Wrench,
  X,
} from "lucide-react";
import type {
  ExplorationChoiceView,
  ExplorationState,
  VoyageView,
} from "../../../packages/shared/src/exploration";
import type { PlayerState } from "../../../packages/shared/src/index";
import {
  RESOURCES,
  type Bundle,
  type Resource,
} from "../../../packages/game-config/src/index";
import { count } from "../../../packages/game-engine/src/index";
import { remaining } from "../../../packages/ui/src/index";
import { useGame } from "./store";
import { useExploration } from "./exploration-store";

type Region = ExplorationState["regions"][number];
type Ship = ExplorationState["ships"][number];
const phases = {
  sailing: "驶向海域",
  choice: "等待你的决定",
  returning: "正在返航",
  ready: "已返航 · 等待卸货",
  claimed: "收获已入库",
};

export function ExplorationBridge({
  ownerId,
}: {
  ownerId: string | undefined;
}) {
  const revision = useGame((s) => s.revisions.state);
  const lastRevision = useRef(revision);
  useEffect(() => {
    useExploration.getState().setOwner(ownerId ?? null);
    if (!ownerId) return;
    const refresh = () => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void useExploration.getState().refresh();
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [ownerId]);
  useEffect(() => {
    if (revision === lastRevision.current) return;
    lastRevision.current = revision;
    if (ownerId) void useExploration.getState().refresh();
  }, [ownerId, revision]);
  return null;
}
export function ExplorationShortcut({ ownerId }: { ownerId: string }) {
  const { data, ownerId: cachedOwner } = useExploration();
  if (cachedOwner !== ownerId || !data) return null;
  const waiting = data.voyages.filter(
    (v) => v.phase === "choice" || v.phase === "ready",
  ).length;
  return (
    <button
      className={`exploration-shortcut ${waiting ? "needs-attention" : ""}`}
      onClick={() => useGame.getState().setPanel("exploration")}
    >
      <Compass size={14} />
      <span>
        {waiting
          ? `${waiting} 艘船等待你`
          : data.voyages.length
            ? `${data.voyages.length} 艘船在旅途中`
            : "打开远海航图"}
      </span>
      <ArrowRight size={13} />
    </button>
  );
}
function Cargo({ resources, stock }: { resources: Bundle; stock?: Bundle }) {
  return (
    <span className="resource-cost expedition-cargo">
      {Object.entries(resources).map(([id, n]) => (
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
function Payment({
  cost,
  coins,
  state,
}: {
  cost: Bundle;
  coins: number;
  state: PlayerState;
}) {
  return (
    <div className="expedition-payment">
      <Cargo resources={cost} stock={state.inventory} />
      {coins > 0 && (
        <span className={state.coins < coins ? "insufficient" : ""}>
          ◈ {coins} 金币
        </span>
      )}
      {!coins && !count(cost) && <span>无需额外物资</span>}
    </div>
  );
}
function canPay(state: PlayerState, cost: Bundle, coins: number) {
  return (
    state.coins >= coins &&
    Object.entries(cost).every(
      ([r, n]) => (state.inventory[r as Resource] ?? 0) >= n,
    )
  );
}
function Stats({ ship }: { ship: Ship }) {
  return (
    <dl className="ship-stats">
      <div>
        <dt>载货量</dt>
        <dd>{ship.stats.capacity}</dd>
      </div>
      <div>
        <dt>耐久</dt>
        <dd>
          {ship.durability}/{ship.stats.maxDurability}
        </dd>
      </div>
      <div>
        <dt>航时倍率</dt>
        <dd>×{ship.stats.speedMultiplier.toFixed(2)}</dd>
      </div>
      <div>
        <dt>抗风险</dt>
        <dd>{ship.stats.resistance}%</dd>
      </div>
    </dl>
  );
}
function Chart({
  regions,
  selected,
  onSelect,
  voyages,
}: {
  regions: Region[];
  selected: string;
  onSelect: (id: string) => void;
  voyages: VoyageView[];
}) {
  return (
    <div className="exploration-chart" aria-label="可交互探索海图">
      <svg viewBox="0 0 100 72" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <pattern
            id="chart-waves"
            width="12"
            height="12"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M1 8 Q3 6 5 8 T9 8"
              fill="none"
              stroke="#d4efdc"
              strokeWidth=".3"
              opacity=".28"
            />
          </pattern>
        </defs>
        <rect width="100" height="72" fill="url(#chart-waves)" />
        {regions.map((region) => (
          <path
            key={region.id}
            d={`M8 63.36 Q ${region.x * 0.6} ${region.y * 0.72 + 15} ${region.x} ${region.y * 0.72}`}
            fill="none"
            stroke={region.id === selected ? "#f5e5a5" : "#d8ecd0"}
            strokeDasharray="1.2 1.8"
            strokeWidth={region.id === selected ? ".55" : ".28"}
            opacity={region.unlocked ? 0.8 : 0.22}
          />
        ))}
      </svg>
      <div className="chart-origin" style={{ left: "8%", top: "88%" }}>
        <Anchor size={19} />
        <span>我的小岛</span>
      </div>
      <span className="chart-compass" aria-hidden="true">
        <Compass size={34} />
        <small>N</small>
      </span>
      {regions.map((region) => (
        <button
          key={region.id}
          className={`chart-node ${region.id === selected ? "selected" : ""} ${!region.unlocked ? "locked" : ""}`}
          style={{ left: `${region.x}%`, top: `${region.y}%` }}
          aria-label={`探索${region.name}`}
          aria-pressed={selected === region.id}
          onClick={() => onSelect(region.id)}
        >
          <span
            className="chart-island"
            style={{ backgroundColor: region.color }}
          >
            {region.unlocked ? <Flag size={22} /> : <LockKeyhole size={18} />}
          </span>
          <strong>{region.name}</strong>
          {voyages.some((v) => v.regionId === region.id) && <i />}
        </button>
      ))}
      <span className="chart-caption">循着潮汐，发现下一片海。</span>
    </div>
  );
}
function VoyageCard({
  voyage,
  now,
  state,
  busy,
  onChoose,
  onClaim,
  durability,
}: {
  voyage: VoyageView;
  now: number;
  state: PlayerState;
  busy: boolean;
  onChoose: (choice: ExplorationChoiceView) => void;
  onClaim: () => void;
  durability: number;
}) {
  const phase = voyage.phase;
  const result = voyage.result;
  const full = result
    ? count(state.inventory) + count(result.resources) > state.capacity
    : false;
  const deadline = phase === "sailing" ? voyage.arrivesAt : voyage.returnsAt;
  return (
    <article
      className={`voyage-card phase-${phase}`}
      data-testid={`voyage-${voyage.id}`}
    >
      <div className="voyage-heading">
        <span className="voyage-emblem">
          {phase === "ready" ? (
            <PackageCheck size={23} />
          ) : (
            <Sailboat size={23} />
          )}
        </span>
        <div>
          <span className="eyebrow">{phases[phase]}</span>
          <h3>{voyage.regionName}</h3>
        </div>
        {deadline && !["choice", "ready", "claimed"].includes(phase) && (
          <strong className="voyage-clock">
            {Date.parse(deadline) > now
              ? remaining(deadline, now)
              : "正在确认抵达…"}
          </strong>
        )}
      </div>
      {phase === "sailing" && (
        <p className="panel-note">
          船员正顺着航线前行。离开小岛也会继续航行，抵达后等你决定下一步。
        </p>
      )}
      {phase === "choice" && voyage.event && (
        <div className="voyage-event">
          <span className="eyebrow">来自船上的消息</span>
          <h4>{voyage.event.title}</h4>
          <p>{voyage.event.description}</p>
          <div className="voyage-choices">
            {voyage.event.choices.map((choice) => (
              <button
                className="voyage-choice"
                key={choice.id}
                disabled={
                  busy ||
                  durability < choice.riskDamage ||
                  !canPay(state, choice.cost, choice.coins)
                }
                onClick={() => onChoose(choice)}
                data-testid={`choice-${choice.id}`}
              >
                <div>
                  <strong>{choice.label}</strong>
                  <span>成功率 {choice.successPercent}%</span>
                </div>
                <p>{choice.description}</p>
                <Payment
                  cost={choice.cost}
                  coins={choice.coins}
                  state={state}
                />
                <small>
                  {durability < choice.riskDamage ? "耐久不足 · " : ""}
                  额外风险损伤 {choice.riskDamage} · 返航 {choice.returnSeconds}{" "}
                  秒
                </small>
              </button>
            ))}
          </div>
          <p className="panel-note">
            一次航程只能做一次决定。风险选择可能失利；你总能选择安全返航。
          </p>
        </div>
      )}
      {result && (
        <div className="voyage-result">
          <span className="result-tag">
            {phase === "claimed"
              ? "已入库"
              : phase === "ready"
                ? "等待卸货的船货"
                : "随船返航的物资"}
          </span>
          <p>{result.narrative}</p>
          <Cargo resources={result.resources} />
          <div className="voyage-reward-meta">
            <span>◈ {result.coins} 金币</span>
            <span>✦ {result.xp} 经验</span>
            <span>事件损伤 {result.damage}</span>
          </div>
        </div>
      )}
      {phase === "ready" && (
        <>
          <button
            className="primary full"
            disabled={busy || full}
            onClick={onClaim}
          >
            <PackageCheck size={17} />
            {busy ? "正在卸货…" : "领取返航收获"}
          </button>
          {full && (
            <div className="cargo-blocked">
              <p>
                仓库空间不足，需要 {count(result?.resources ?? {})} 格，当前可用{" "}
                {Math.max(0, state.capacity - count(state.inventory))}{" "}
                格。船货会留在船上，腾出空间后再领取。
              </p>
              <button
                className="text-button"
                onClick={() => useGame.getState().setPanel("inventory")}
              >
                前往整理仓库 <ArrowRight size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </article>
  );
}

function ConfirmationBoundary({
  children,
  onCancel,
}: {
  children: ReactNode;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelRef.current();
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      if (!buttons.length) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault();
        buttons.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
        event.preventDefault();
        buttons[0]?.focus();
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      previous?.focus();
    };
  }, []);
  return (
    <div ref={ref} className="exploration-confirm-backdrop">
      {children}
    </div>
  );
}

export function Exploration({ state }: { state: PlayerState }) {
  const { data, ownerId, loading, error, offset } = useExploration();
  const gameBusy = useGame((s) => s.busy);
  const [working, setWorking] = useState(false);
  const pendingAction = useRef(false);
  const busy = gameBusy || working;
  const [tab, setTab] = useState<"chart" | "fleet" | "log">("chart");
  const [selected, setSelected] = useState("bay");
  const [shipId, setShipId] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: ReactNode;
    action: string;
    body: unknown;
    button: string;
    label: string;
  } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const now = clock + offset;
  useEffect(() => {
    if (!data) return;
    const deadlines = data.voyages.flatMap((v) =>
      v.phase === "sailing"
        ? [Date.parse(v.arrivesAt)]
        : v.phase === "returning" && v.returnsAt
          ? [Date.parse(v.returnsAt)]
          : [],
    );
    if (!deadlines.length) return;
    const next = Math.max(
      1000,
      Math.min(...deadlines) - Date.now() - offset + 150,
    );
    const timer = setTimeout(
      () => void useExploration.getState().refresh(),
      next,
    );
    return () => clearTimeout(timer);
  }, [data, offset]);
  if (!data || ownerId !== state.id)
    return (
      <div className="exploration-loading">
        <Compass size={40} />
        <h3>{error ? "海图暂时无法展开" : "正在展开远海航图…"}</h3>
        {error && <p role="alert">{error}</p>}
        <button
          className="secondary"
          disabled={loading}
          onClick={() => void useExploration.getState().refresh()}
        >
          {loading ? "同步中…" : "重新同步"}
        </button>
      </div>
    );
  const region = data.regions.find((r) => r.id === selected) ?? data.regions[0];
  const idleShips = data.ships.filter((s) => !s.activeVoyageId);
  const ship = idleShips.find((s) => s.id === shipId) ?? idleShips[0];
  const dispatchReason = !data.hasDock
    ? "先建造交易码头，再安排出航"
    : !region.unlocked
      ? (region.lockReason ?? "尚未解锁这片海域")
      : !ship
        ? "先造一艘船，或等船只返航卸货"
        : ship.level < region.minShipLevel
          ? `需要 Lv.${region.minShipLevel} 船只`
          : ship.durability < region.baseWear
            ? "耐久不足，请先维修船只"
            : !canPay(state, region.supplies, region.coins)
              ? "出航补给不足，请先准备物资"
              : null;
  const act = async (action: string, body: unknown) => {
    if (pendingAction.current) return false;
    pendingAction.current = true;
    setWorking(true);
    try {
      const ok = await useGame
        .getState()
        .action(`/exploration/${action}`, body);
      await useExploration.getState().refresh();
      return ok;
    } finally {
      pendingAction.current = false;
      setWorking(false);
    }
  };
  const choose = (voyage: VoyageView, choice: ExplorationChoiceView) =>
    setConfirmation({
      title: choice.label,
      label: "确认航海选择",
      description: (
        <>
          <p>{choice.description}</p>
          <Payment cost={choice.cost} coins={choice.coins} state={state} />
          <p>
            成功率 {choice.successPercent}%，风险损伤 {choice.riskDamage}，预计{" "}
            {choice.returnSeconds} 秒后返航。确认后无法更换选择。
          </p>
        </>
      ),
      action: "choose",
      body: { voyageId: voyage.id, choiceId: choice.id },
      button: "确认选择",
    });
  return (
    <div className="exploration-panel">
      <div className="exploration-intro">
        <div className="exploration-mark">
          <Compass size={30} />
        </div>
        <div>
          <h3>每一次出发，都带着新的可能</h3>
          <p>造一艘船，备好补给，把远海的故事带回小岛。</p>
        </div>
        <span>{data.progress.claimed} 次归航</span>
      </div>
      {error && (
        <div className="fetch-error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => void useExploration.getState().refresh()}
          >
            重试同步海图
          </button>
        </div>
      )}
      {!data.hasDock && (
        <div className="notice expedition-dock-note">
          <span>交易码头也是探索船只的母港。建好码头，再开始第一场远航。</span>
          <button
            className="text-button"
            onClick={() => useGame.getState().setPanel("build")}
          >
            去建造码头 <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="tabs">
        {(
          [
            ["chart", "海域航图"],
            ["fleet", "我的船队"],
            ["log", "航海日志"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "fleet" && ` · ${data.ships.length}`}
          </button>
        ))}
      </div>
      {tab === "chart" && (
        <>
          {!!data.voyages.length && (
            <div className="active-voyages">
              <h3>
                <Waves size={18} />
                海上的牵挂
              </h3>
              {data.voyages.map((v) => (
                <VoyageCard
                  key={v.id}
                  voyage={v}
                  now={now}
                  state={state}
                  busy={busy}
                  durability={
                    data.ships.find((ship) => ship.id === v.shipId)
                      ?.durability ?? 0
                  }
                  onChoose={(choice) => choose(v, choice)}
                  onClaim={() => void act("claim", { voyageId: v.id })}
                />
              ))}
            </div>
          )}
          <Chart
            regions={data.regions}
            selected={region.id}
            onSelect={setSelected}
            voyages={data.voyages}
          />
          <label className="region-select-label">
            目的海域
            <select
              aria-label="选择探索海域"
              value={region.id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {data.regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.unlocked ? "" : " · 未解锁"}
                </option>
              ))}
            </select>
          </label>
          <section className="region-detail">
            <div className="region-heading">
              <div>
                <span className="eyebrow">
                  {region.unlocked ? "可以启航" : "等待发现"} · 完成{" "}
                  {region.completed} 次
                </span>
                <h3>{region.name}</h3>
              </div>
              <span className="region-risk">
                <Shield size={14} />
                基础风险 {region.riskPercent}%
              </span>
            </div>
            <p>{region.description}</p>
            {!region.unlocked && (
              <div className="region-lock">
                <LockKeyhole size={15} />
                {region.lockReason}
              </div>
            )}
            <div className="region-facts">
              <span>基础航程 {region.seconds} 秒</span>
              <span>基础损耗 {region.baseWear}</span>
              <span>建议船级 Lv.{region.recommendedShipLevel}</span>
            </div>
            <div className="region-loot">
              <small>可能带回的基础船货 · 以实际事件结果为准</small>
              <div>
                {region.loot.map((loot) => (
                  <span key={loot.resource}>
                    {RESOURCES[loot.resource].icon}{" "}
                    {RESOURCES[loot.resource].name} {loot.min}–{loot.max}
                  </span>
                ))}
              </div>
            </div>
            <div className="dispatch-form">
              <label>
                派遣船只
                <select
                  aria-label="派遣船只"
                  value={ship?.id ?? ""}
                  onChange={(e) => setShipId(e.target.value)}
                  disabled={!idleShips.length}
                >
                  <option value="" disabled>
                    暂无空闲船只
                  </option>
                  {idleShips.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · Lv.{s.level} · 耐久 {s.durability}/
                      {s.stats.maxDurability}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <small>出航补给</small>
                <Payment
                  cost={region.supplies}
                  coins={region.coins}
                  state={state}
                />
              </div>
            </div>
            {ship && (
              <p className="panel-note">
                这艘船载货 {ship.stats.capacity}，航时 ×
                {ship.stats.speedMultiplier.toFixed(2)}，预计{" "}
                {Math.max(
                  20,
                  Math.ceil(region.seconds * ship.stats.speedMultiplier),
                )}{" "}
                秒抵达事件海域，以启航后的倒计时为准。出航时扣除补给，返航领取前船只保持占用。
              </p>
            )}
            <button
              className="primary full"
              disabled={busy || !!dispatchReason}
              onClick={() =>
                ship &&
                setConfirmation({
                  title: `向${region.name}出发`,
                  label: "确认探索出航",
                  description: (
                    <>
                      <p>
                        {ship.name} · Lv.{ship.level} · 耐久 {ship.durability}/
                        {ship.stats.maxDurability}
                      </p>
                      <Payment
                        cost={region.supplies}
                        coins={region.coins}
                        state={state}
                      />
                      <p>
                        扣除以上补给后启航，预计{" "}
                        {Math.max(
                          20,
                          Math.ceil(
                            region.seconds * ship.stats.speedMultiplier,
                          ),
                        )}{" "}
                        秒抵达。基础风险 {region.riskPercent}
                        %，抵达后再选择行动。航程无法撤销。
                      </p>
                    </>
                  ),
                  action: "dispatch",
                  body: { shipId: ship.id, regionId: region.id },
                  button: "确认派遣",
                })
              }
            >
              <Sailboat size={17} />
              准备出航 <ArrowRight size={17} />
            </button>
            {dispatchReason && (
              <p className="dispatch-reason">
                {dispatchReason}
                {!ship && data.hasDock && (
                  <button
                    className="text-button"
                    onClick={() => setTab("fleet")}
                  >
                    查看我的船队 →
                  </button>
                )}
              </p>
            )}
          </section>
        </>
      )}
      {tab === "fleet" && (
        <>
          <div className="fleet-summary">
            <span>
              <Sailboat size={18} />
              船位 {data.ships.length}/{data.fleetLimit}
            </span>
            <p>
              每种船只能拥有一艘。升级改变载货、航速和抗风险，维修恢复耐久。
            </p>
          </div>
          <div className="fleet-list">
            {data.ships.map((s) => (
              <article
                className="ship-card"
                key={s.id}
                data-testid={`ship-${s.id}`}
              >
                <div className="ship-card-heading">
                  <span>
                    {data.shipyard.find((b) => b.kind === s.kind)?.icon ?? "⛵"}
                  </span>
                  <div>
                    <h3>
                      {s.name}
                      <small>Lv.{s.level}</small>
                    </h3>
                    <p>
                      {s.activeVoyageId
                        ? "正在执行航程 · 卸货后可再次派遣"
                        : "停泊在小岛 · 随时准备出发"}
                    </p>
                  </div>
                </div>
                <Stats ship={s} />
                <div className="ship-maintenance">
                  {s.upgrade ? (
                    <div>
                      <strong>升级船只</strong>
                      <Payment
                        cost={s.upgrade.cost}
                        coins={s.upgrade.coins}
                        state={state}
                      />
                      <button
                        className="secondary"
                        disabled={
                          busy ||
                          !!s.activeVoyageId ||
                          !canPay(state, s.upgrade.cost, s.upgrade.coins)
                        }
                        onClick={() =>
                          setConfirmation({
                            title: `升级${s.name}`,
                            label: "确认升级船只",
                            description: (
                              <>
                                <p>
                                  升级至 Lv.{s.level + 1}
                                  ，新属性会在完成后显示。
                                </p>
                                <Payment
                                  cost={s.upgrade!.cost}
                                  coins={s.upgrade!.coins}
                                  state={state}
                                />
                              </>
                            ),
                            action: "upgrade",
                            body: { shipId: s.id },
                            button: "确认升级",
                          })
                        }
                      >
                        升级至 Lv.{s.level + 1}
                      </button>
                    </div>
                  ) : (
                    <p className="panel-note">船只已达最高等级</p>
                  )}
                  {s.repair ? (
                    <div>
                      <strong>修复耐久</strong>
                      <Payment
                        cost={s.repair.cost}
                        coins={s.repair.coins}
                        state={state}
                      />
                      <button
                        className="secondary"
                        disabled={
                          busy ||
                          !!s.activeVoyageId ||
                          !canPay(state, s.repair.cost, s.repair.coins)
                        }
                        onClick={() =>
                          setConfirmation({
                            title: `维修${s.name}`,
                            label: "确认维修船只",
                            description: (
                              <>
                                <p>
                                  将耐久恢复至 {s.stats.maxDurability}
                                  。已在海上的船需返航卸货后维修。
                                </p>
                                <Payment
                                  cost={s.repair!.cost}
                                  coins={s.repair!.coins}
                                  state={state}
                                />
                              </>
                            ),
                            action: "repair",
                            body: { shipId: s.id },
                            button: "确认维修",
                          })
                        }
                      >
                        <Wrench size={14} />
                        维修船只
                      </button>
                    </div>
                  ) : (
                    <p className="panel-note">
                      <Check size={13} />
                      船况良好，无需维修
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
          <h3 className="shipyard-heading">
            <Anchor size={18} />
            小岛造船坞
          </h3>
          <div className="shipyard-grid">
            {data.shipyard.map((blueprint) => (
              <article
                className="blueprint-card"
                key={blueprint.kind}
                data-testid={`shipyard-${blueprint.kind}`}
              >
                <span className="blueprint-art">{blueprint.icon}</span>
                <h3>{blueprint.name}</h3>
                <p>{blueprint.description}</p>
                <div className="blueprint-specs">
                  <span>载货 {blueprint.stats.capacity}</span>
                  <span>耐久 {blueprint.stats.maxDurability}</span>
                  <span>
                    航时 ×{blueprint.stats.speedMultiplier.toFixed(2)}
                  </span>
                  <span>抗风险 {blueprint.stats.resistance}%</span>
                </div>
                <Payment
                  cost={blueprint.cost}
                  coins={blueprint.coins}
                  state={state}
                />
                <button
                  className="primary full"
                  disabled={
                    busy ||
                    blueprint.owned ||
                    !data.hasDock ||
                    state.level < blueprint.unlockLevel ||
                    data.ships.length >= data.fleetLimit ||
                    !canPay(state, blueprint.cost, blueprint.coins)
                  }
                  onClick={() =>
                    setConfirmation({
                      title: `建造${blueprint.name}`,
                      label: "确认建造船只",
                      description: (
                        <>
                          <p>{blueprint.description}</p>
                          <Payment
                            cost={blueprint.cost}
                            coins={blueprint.coins}
                            state={state}
                          />
                          <p>建造完成后停泊在交易码头，船只不占用木筏地板。</p>
                        </>
                      ),
                      action: "build",
                      body: { kind: blueprint.kind },
                      button: "确认建造",
                    })
                  }
                >
                  {blueprint.owned
                    ? "已经拥有"
                    : state.level < blueprint.unlockLevel
                      ? `Lv.${blueprint.unlockLevel} 解锁`
                      : `建造${blueprint.name}`}
                </button>
              </article>
            ))}
          </div>
        </>
      )}
      {tab === "log" && (
        <div className="voyage-history">
          {data.history.length ? (
            data.history.map((v) => (
              <article
                className="history-voyage"
                key={v.id}
                data-testid={`voyage-${v.id}`}
              >
                <div>
                  <span>
                    <Flag size={17} />
                    {v.regionName}
                  </span>
                  <time>
                    {new Date(v.claimedAt ?? v.departedAt).toLocaleString(
                      "zh-CN",
                    )}
                  </time>
                </div>
                <p>{v.result?.narrative}</p>
                {v.result && (
                  <>
                    <Cargo resources={v.result.resources} />
                    <small>
                      ◈ {v.result.coins} 金币 · ✦ {v.result.xp} 经验 · 耐久损耗{" "}
                      {v.result.damage}
                    </small>
                  </>
                )}
              </article>
            ))
          ) : (
            <div className="empty-state">
              <Map size={40} />
              <h3>你的第一段航海故事还未写下</h3>
              <p>从近海出发，选择行动，返航领取后会记录在这里。</p>
              <button className="text-button" onClick={() => setTab("chart")}>
                回到海域航图 →
              </button>
            </div>
          )}
        </div>
      )}
      {confirmation && (
        <ConfirmationBoundary
          onCancel={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <div
            className="exploration-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label={confirmation.label}
          >
            <div className="confirmation-heading">
              <Compass size={22} />
              <h3>{confirmation.title}</h3>
              <button
                className="icon-button"
                disabled={busy}
                aria-label="取消确认"
                onClick={() => setConfirmation(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="confirmation-body">{confirmation.description}</div>
            <div className="confirm-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                再想一想
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  if (await act(confirmation.action, confirmation.body))
                    setConfirmation(null);
                }}
              >
                {busy ? "正在安排…" : confirmation.button}
              </button>
            </div>
          </div>
        </ConfirmationBoundary>
      )}
      <div className="exploration-footnote">
        <Sparkles size={13} />
        船货以实际航程结算为准。离线航行继续，事件会等你回来决定。
      </div>
    </div>
  );
}
