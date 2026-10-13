import type { SyncTopic } from "./store";
export type SyncNotice = {
  eventId: string;
  epoch: string;
  sequence: number;
  topics: SyncTopic[];
  emittedAt: string;
};
export function createSyncGate() {
  let epoch = "";
  let sequence = -1;
  const seen = new Set<string>();
  return {
    ready(message: { epoch: string; sequence: number }) {
      if (message.epoch !== epoch) {
        epoch = message.epoch;
        sequence = -1;
        seen.clear();
      }
      sequence = Math.max(sequence, message.sequence);
    },
    accept(message: SyncNotice): SyncTopic[] {
      if (
        !message ||
        !Number.isSafeInteger(message.sequence) ||
        !Array.isArray(message.topics)
      )
        return [];
      const restarted = epoch !== message.epoch;
      if (restarted) {
        epoch = message.epoch;
        sequence = -1;
        seen.clear();
      }
      if (message.sequence <= sequence || seen.has(message.eventId)) return [];
      sequence = message.sequence;
      seen.add(message.eventId);
      if (seen.size > 128) seen.delete(seen.values().next().value!);
      return restarted
        ? ["state", "market", "friends", "leaderboard"]
        : message.topics.filter((t) =>
            ["state", "market", "friends", "leaderboard"].includes(t),
          );
    },
  };
}
