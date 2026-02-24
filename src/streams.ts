import type { IStream } from "iii-sdk/stream";
import { iii } from "./iii.js";

interface ChatEvent {
  type: string;
  data: unknown;
  timestamp: number;
}

const store = new Map<string, Map<string, ChatEvent>>();

const TTL_MS = 30 * 60 * 1000;
const MAX_GROUPS = 100;

function refreshGroup(group_id: string): Map<string, ChatEvent> | undefined {
  const group = store.get(group_id);
  if (group) {
    store.delete(group_id);
    store.set(group_id, group);
  }
  return group;
}

const chatStream: IStream<ChatEvent> = {
  async get({ group_id, item_id }) {
    const group = refreshGroup(group_id);
    return group?.get(item_id) ?? null;
  },

  async set({ group_id, item_id, data }) {
    if (!store.has(group_id)) {
      if (store.size >= MAX_GROUPS) {
        const oldest = store.keys().next().value;
        if (oldest) store.delete(oldest);
      }
      store.set(group_id, new Map());
    } else {
      refreshGroup(group_id);
    }
    const group = store.get(group_id)!;
    const old = group.get(item_id) ?? null;
    const event: ChatEvent = {
      ...data,
      timestamp: data.timestamp ?? Date.now(),
    };
    group.set(item_id, event);
    return { old_value: old ?? undefined, new_value: event };
  },

  async delete({ group_id, item_id }) {
    const group = store.get(group_id);
    if (!group) return {};
    const old = group.get(item_id);
    group.delete(item_id);
    if (group.size === 0) store.delete(group_id);
    return old ? { old_value: old } : {};
  },

  async list({ group_id }) {
    const group = refreshGroup(group_id);
    if (!group) return [];
    return Array.from(group.values()).sort((a, b) => a.timestamp - b.timestamp);
  },

  async listGroups() {
    return Array.from(store.keys());
  },

  async update({ group_id, item_id, ops }) {
    const group = refreshGroup(group_id);
    if (!group) return null;
    const existing = group.get(item_id);
    if (!existing) return null;
    const updated = { ...existing } as Record<string, unknown>;
    for (const op of ops) {
      if (op.type === "set") updated[op.path] = op.value;
      if (op.type === "remove") delete updated[op.path];
      if (op.type === "merge" && typeof updated[op.path] === "object") {
        updated[op.path] = {
          ...(updated[op.path] as Record<string, unknown>),
          ...op.value,
        };
      }
    }
    const newVal = updated as unknown as ChatEvent;
    group.set(item_id, newVal);
    return { old_value: existing, new_value: newVal };
  },
};

export function registerChatStream(): void {
  iii.createStream("chat", chatStream);
}

export function writeChatEvent(
  requestId: string,
  index: number,
  event: { type: string; [key: string]: unknown },
): void {
  chatStream
    .set({
      stream_name: "chat",
      group_id: requestId,
      item_id: String(index),
      data: { type: event.type, data: event, timestamp: Date.now() },
    })
    .catch(() => {});
}

export async function listChatEvents(requestId: string): Promise<ChatEvent[]> {
  return chatStream.list({ stream_name: "chat", group_id: requestId });
}

export function deleteChatGroup(requestId: string): void {
  store.delete(requestId);
}

export function cleanupStaleStreams(): number {
  const now = Date.now();
  let removed = 0;
  for (const [groupId, group] of store) {
    let newest = 0;
    for (const event of group.values()) {
      if (event.timestamp > newest) newest = event.timestamp;
    }
    if (now - newest > TTL_MS) {
      store.delete(groupId);
      removed++;
    }
  }
  return removed;
}
