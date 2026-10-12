import { create } from "zustand";
import type { PlayerState } from "../../../packages/shared/src/index";
import type { BuildingKind } from "../../../packages/game-config/src/index";
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
  const send = () =>
    fetch(`/api${path}`, {
      method,
      headers,
      credentials: "include",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  let res: Response;
  try {
    res = await send();
  } catch {
    res = await send();
  } // Same idempotency key for a transport retry.
  const result = await res.json();
  if (!res.ok)
    throw new ApiError(res.status, result.error?.message ?? "请求失败");
  return result as T;
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
interface Store {
  state: PlayerState | null;
  loading: boolean;
  connected: boolean;
  panel: Panel;
  placement: Placement;
  selected: string | null;
  busy: boolean;
  toast: string | null;
  offset: number;
  refresh: () => Promise<void>;
  action: (path: string, body: unknown) => Promise<boolean>;
  notify: (message: string) => void;
  setPanel: (panel: Panel) => void;
}
let toastTimer: ReturnType<typeof setTimeout>;
export const useGame = create<Store>((set, get) => ({
  state: null,
  loading: true,
  connected: false,
  panel: null,
  placement: null,
  selected: null,
  busy: false,
  toast: null,
  offset: 0,
  refresh: async () => {
    try {
      const state = await api<PlayerState>("/state");
      set({
        state,
        connected: true,
        loading: false,
        offset: Date.parse(state.serverTime) - Date.now(),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        set({ state: null, loading: false });
      else {
        set({ loading: false, connected: false });
        get().notify(e instanceof Error ? e.message : "连接失败");
      }
    }
  },
  action: async (path, body) => {
    if (get().busy) return false;
    set({ busy: true });
    try {
      const result = await api<{ message?: string }>(path, body);
      await get().refresh();
      get().notify(result.message ?? "操作成功");
      return true;
    } catch (e) {
      get().notify(e instanceof Error ? e.message : "操作失败");
      return false;
    } finally {
      set({ busy: false });
    }
  },
  notify: (message) => {
    clearTimeout(toastTimer);
    set({ toast: message });
    toastTimer = setTimeout(() => set({ toast: null }), 4000);
  },
  setPanel: (panel) => set({ panel, selected: null, placement: null }),
}));
