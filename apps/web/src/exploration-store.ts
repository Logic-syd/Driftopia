import { create } from "zustand";
import { api } from "./store";
import type { ExplorationState } from "../../../packages/shared/src/exploration";

interface ExplorationStore {
  ownerId: string | null;
  data: ExplorationState | null;
  loading: boolean;
  error: string | null;
  offset: number;
  setOwner: (id: string | null) => void;
  refresh: () => Promise<void>;
}
let fetching = false;
let generation = 0;
const waiting: (() => void)[] = [];
export const useExploration = create<ExplorationStore>((set, get) => ({
  ownerId: null,
  data: null,
  loading: false,
  error: null,
  offset: 0,
  setOwner: (id) => {
    if (id === get().ownerId) return;
    generation++;
    set({ ownerId: id, data: null, error: null, loading: false });
  },
  refresh: () => {
    if (!get().ownerId) return Promise.resolve();
    const completed = new Promise<void>((resolve) => waiting.push(resolve));
    if (fetching) return completed;
    fetching = true;
    void (async () => {
      try {
        while (waiting.length) {
          const batch = waiting.splice(0),
            requestGeneration = generation;
          if (!get().ownerId) {
            batch.forEach((resolve) => resolve());
            continue;
          }
          set({ loading: true });
          try {
            const data = await api<ExplorationState>("/exploration");
            if (requestGeneration === generation)
              set({
                data,
                error: null,
                offset: Date.parse(data.serverTime) - Date.now(),
              });
          } catch (error) {
            if (requestGeneration === generation)
              set({
                error:
                  error instanceof Error ? error.message : "海图暂时无法同步",
              });
          } finally {
            batch.forEach((resolve) => resolve());
          }
        }
      } finally {
        fetching = false;
        set({ loading: false });
      }
    })();
    return completed;
  },
}));
