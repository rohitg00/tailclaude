import {
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { state } from "./state.js";
import { emit } from "./hooks.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface SessionIndexEntry {
  id: string;
  slug?: string;
  project?: string;
  cwd?: string;
  messageCount: number;
  lastModified: string;
  filePath: string;
}

let indexing = false;

export async function indexSessions(): Promise<void> {
  if (indexing) return;
  indexing = true;
  try {
    await doIndexSessions();
  } finally {
    indexing = false;
  }
}

async function doIndexSessions(): Promise<void> {
  const entries: SessionIndexEntry[] = [];

  try {
    const projects = readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const projEntry of projects) {
      if (!projEntry.isDirectory()) continue;

      const projDir = join(PROJECTS_DIR, projEntry.name);
      const projectName = extractProjectName(projEntry.name);

      try {
        const files = readdirSync(projDir);
        const jsonlFiles = files.filter(
          (f) => f.endsWith(".jsonl") && !f.includes("memory"),
        );

        for (const file of jsonlFiles) {
          const filePath = join(projDir, file);
          try {
            const stat = statSync(filePath);
            if (stat.size < 50) continue;
            const sessionId = file.replace(".jsonl", "");

            let project: string | undefined = projectName;
            let messageCount = 0;
            let slug: string | undefined;
            let cwd: string | undefined;

            const fd = openSync(filePath, "r");
            const buf = Buffer.alloc(8192);
            const bytesRead = readSync(fd, buf, 0, 8192, 0);
            closeSync(fd);
            const head = buf.toString("utf-8", 0, bytesRead);
            const lines = head.split("\n").filter((l: string) => l.trim());

            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.cwd && !cwd) {
                  cwd = parsed.cwd;
                  if (!project)
                    project = parsed.cwd.split("/").pop() || project;
                }
                if (parsed.slug && !slug) slug = parsed.slug;
                const role = parsed.message?.role;
                if (role === "user" || role === "assistant") messageCount++;
              } catch {
                // skip
              }
            }

            entries.push({
              id: sessionId,
              slug,
              project,
              cwd,
              messageCount: messageCount || 0,
              lastModified: stat.mtime.toISOString(),
              filePath,
            });
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // skip unreadable project dirs
      }
    }
  } catch {
    // projects directory doesn't exist
  }

  for (const entry of entries) {
    await state.set({
      scope: "session_index",
      key: entry.id,
      data: entry,
    });
  }

  await emit("session::indexed", {
    total: entries.length,
    added: entries.length,
  });
}

export async function getSessionIndex(): Promise<SessionIndexEntry[]> {
  try {
    const sessions = await state.list<SessionIndexEntry>({
      scope: "session_index",
    });
    return sessions.sort(
      (a, b) =>
        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
    );
  } catch {
    return [];
  }
}

export async function getSessionFilePath(
  sessionId: string,
): Promise<string | null> {
  try {
    const entry = await state.get<SessionIndexEntry>({
      scope: "session_index",
      key: sessionId,
    });
    return entry?.filePath ?? null;
  } catch {
    return null;
  }
}

export async function cleanStaleSessionIndex(): Promise<number> {
  let removed = 0;
  try {
    const sessions = await state.list<SessionIndexEntry>({
      scope: "session_index",
    });
    for (const session of sessions) {
      if (!existsSync(session.filePath)) {
        await state.delete({ scope: "session_index", key: session.id });
        removed++;
      }
    }
  } catch {
    // state unavailable
  }
  return removed;
}

function extractProjectName(dirName: string): string {
  const cleaned = dirName.replace(/^-/, "");
  const parts = cleaned.split("-");
  if (parts.length <= 2) return parts.pop() || dirName;
  const meaningful = parts.filter(
    (p) => p !== "Users" && p !== "private" && p !== "tmp" && p.length > 1,
  );
  return meaningful.pop() || parts.pop() || dirName;
}
