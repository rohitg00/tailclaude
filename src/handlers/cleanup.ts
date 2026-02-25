import type { Context } from "iii-sdk";
import { Logger } from "iii-sdk";
import { state } from "../state.js";
import { emit } from "../hooks.js";
import { cleanStaleSessionIndex } from "../sessions.js";
import { cleanupStaleStreams } from "../streams.js";

type Session = {
  id: string;
  model: string;
  createdAt: string;
  lastUsed: string;
  messageCount: number;
};

type ActiveChat = {
  sessionId: string | null;
  model: string;
  startedAt: string;
  pid: number | null;
};

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const logger = new Logger(undefined, "tailclaude-cleanup");

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const handleCleanup = async (_ctx: Context): Promise<void> => {
  let removedSessions = 0;
  let removedActiveChats = 0;
  let removedSessionIndex = 0;
  let removedStreams = 0;

  let sessions: Session[] = [];
  try {
    sessions = await state.list<Session>({ scope: "sessions" });
  } catch (err) {
    logger.warn("Failed to list sessions for cleanup", {
      error: (err as Error)?.message,
    });
  }
  const now = Date.now();

  for (const session of sessions) {
    const age = now - new Date(session.lastUsed).getTime();
    if (age > MAX_AGE_MS) {
      await state.delete({ scope: "sessions", key: session.id });
      removedSessions++;
    }
  }

  try {
    const activeChats = await state.list<
      ActiveChat & { key?: string; id?: string }
    >({
      scope: "active_chats",
    });
    for (const chat of activeChats) {
      const key = chat.key || chat.id || "";
      if (!key) continue;
      if (chat.pid && !isProcessRunning(chat.pid)) {
        await state.delete({ scope: "active_chats", key });
        removedActiveChats++;
      }
    }
  } catch {
    // active_chats scope may not exist yet
  }

  try {
    removedSessionIndex = await cleanStaleSessionIndex();
  } catch {
    // session index cleanup failed
  }

  try {
    removedStreams = cleanupStaleStreams();
  } catch (err) {
    logger.error("Failed to cleanup stale streams", {
      error: (err as Error)?.message,
    });
  }

  const total =
    removedSessions + removedActiveChats + removedSessionIndex + removedStreams;

  if (total > 0) {
    logger.info("Cleanup completed", {
      removedSessions,
      removedActiveChats,
      removedSessionIndex,
      removedStreams,
    });
  }

  try {
    await emit("cleanup::completed", {
      removedSessions,
      removedActiveChats,
      removedSessionIndex,
      removedStreams,
      total,
    });
  } catch (err) {
    logger.error("Failed to emit cleanup::completed", {
      error: (err as Error)?.message,
    });
  }
};
