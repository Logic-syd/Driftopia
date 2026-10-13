import { create } from "zustand";
import type { PlayerState } from "../../../packages/shared/src/index";
import type { BuildingKind } from "../../../packages/game-config/src/index";
import { playFeedback } from "./feedback";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  const send = async (): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`/api${path}`, {
        method,
        headers,
        credentials: "include",
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      // The deadline covers the response body as well as the headers. A server
      // may commit a write and then lose its connection mid-body.
      const result = await res.json();
      if (!res.ok)
        throw new ApiError(
          res.status,
          result?.error?.message ?? `服务暂不可用（${res.status}），请稍后重试`,
        );
      if (result === null) throw new Error("服务器返回异常，请重试同步");
      return result as T;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await send();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    try {
      return await send();
    } catch (retryError) {
      if (retryError instanceof ApiError) throw retryError;
      throw new Error(
        "暂时无法连接小岛，请检查网络后重试。已提交的操作会在重连后核对。",
      );
    }
  } // Every transport retry reuses the same idempotency key and request body.
}
export type Panel =
  | "build"
  | "inventory"
  | "orders"
  | "market"
  | "friends"
  | "ranking"
  | "settings"
  | "profile"
  | null;
export type Placement = {
  kind: BuildingKind | "floor";
  movingId?: string;
} | null;
export type SyncTopic = "state" | "market" | "friends" | "leaderboard";
interface Store {
  state: PlayerState | null;
  loading: boolean;
  connected: boolean;
  socketStatus: "connecting" | "connected" | "reconnecting" | "offline";
  syncError: string | null;
  syncing: boolean;
  revisions: Record<SyncTopic, number>;
  panel: Panel;
  placement: Placement;
  selected: string | null;
  busy: boolean;
  toast: string | null;
  toastKind: "success" | "error";
  offset: number;
  refresh: () => Promise<void>;
  invalidate: (topics: SyncTopic[]) => void;
  action: (path: string, body: unknown) => Promise<boolean>;
  notify: (message: string, kind?: "success" | "error") => void;
  setPanel: (panel: Panel) => void;
}
let toastTimer: ReturnType<typeof setTimeout>;
let refreshInFlight = false;
const refreshWaiters: (() => void)[] = [];
let sessionGeneration = 0;
export function clearSession() {
  sessionGeneration++;
  useGame.setState({
    state: null,
    loading: false,
    panel: null,
    selected: null,
    placement: null,
    connected: false,
    syncError: null,
  });
}
export const useGame = create<Store>((set, get) => ({
  state: null,
  loading: true,
  connected: false,
  socketStatus: "connecting",
  syncError: null,
  syncing: false,
  revisions: { state: 0, market: 0, friends: 0, leaderboard: 0 },
  panel: null,
  placement: null,
  selected: null,
  busy: false,
  toast: null,
  toastKind: "success",
  offset: 0,
  refresh: () => {
    const completed = new Promise<void>((resolve) =>
      refreshWaiters.push(resolve),
    );
    if (refreshInFlight) return completed;
    refreshInFlight = true;
    set({ syncing: true });
    void (async () => {
      try {
        while (refreshWaiters.length) {
          // New invalidations join the next fetch. Callers of this fetch can
          // finish even if a busy world keeps adding subsequent notifications.
          const batch = refreshWaiters.splice(0);
          const generation = sessionGeneration;
          try {
            const state = await api<PlayerState>("/state");
            if (generation !== sessionGeneration) continue;
            set({
              state,
              connected: true,
              loading: false,
              syncError: null,
              offset: Date.parse(state.serverTime) - Date.now(),
            });
          } catch (e) {
            if (generation !== sessionGeneration) continue;
            if (e instanceof ApiError && e.status === 401)
              set({
                state: null,
                loading: false,
                connected: false,
                syncError: null,
              });
            else
              set({
                loading: false,
                connected: false,
                syncError: e instanceof Error ? e.message : "连接失败",
              });
          } finally {
            batch.forEach((resolve) => resolve());
          }
        }
      } finally {
        refreshInFlight = false;
        set({ syncing: false });
      }
    })();
    return completed;
  },
  invalidate: (topics) => {
    set((s) => ({
      revisions: Object.fromEntries(
        Object.entries(s.revisions).map(([topic, revision]) => [
          topic,
          revision + (topics.includes(topic as SyncTopic) ? 1 : 0),
        ]),
      ) as Record<SyncTopic, number>,
    }));
    if (topics.includes("state")) void get().refresh();
  },
  action: async (path, body) => {
    if (get().busy) return false;
    if (!navigator.onLine) {
      get().notify("网络已离线，恢复连接后再操作", "error");
      return false;
    }
    set({ busy: true });
    try {
      const result = await api<{ message?: string }>(path, body);
      await get().refresh();
      get().notify(result.message ?? "操作成功");
      playFeedback(path.includes("salvage") ? "salvage" : "success");
      return true;
    } catch (e) {
      get().notify(e instanceof Error ? e.message : "操作失败", "error");
      // A failed response can follow a committed transaction. Always reconcile.
      void get().refresh();
      return false;
    } finally {
      set({ busy: false });
    }
  },
  notify: (message, kind = "success") => {
    clearTimeout(toastTimer);
    set({ toast: message, toastKind: kind });
    toastTimer = setTimeout(() => set({ toast: null }), 5000);
  },
  setPanel: (panel) => set({ panel, selected: null, placement: null }),
}));
