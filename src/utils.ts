// Utility helpers for the memory plugin

import { createHash } from "node:crypto"
import { randomUUID } from "node:crypto"
import type { Memory, MemoryType, MemoryScope } from "./schema.ts"
import type { Message, Part } from "@opencode-ai/sdk"

/** Hash a directory path to a safe folder name. */
export function hashDir(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 24)
}

/** Rough token estimate: ~4 chars = 1 token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Generate a new memory ID. */
export function newId(): string {
  return randomUUID()
}

/** Current Unix timestamp in milliseconds. */
export function now(): number {
  return Date.now()
}

/** Format conversation messages for the extraction prompt. */
export function formatConversation(messages: Array<{ info: Message; parts: Part[] }>): string {
  const lines: string[] = []

  for (const msg of messages) {
    const role = msg.info.role

    if (role === "user") {
      const textParts = msg.parts
        .filter((p) => p.type === "text" && !(p as { synthetic?: boolean }).synthetic)
        .map((p) => (p as { text: string }).text)
        .join("\n")
      if (textParts) lines.push(`[user]\n${textParts}`)
    } else if (role === "assistant") {
      const textParts = msg.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n")
      if (textParts) lines.push(`[assistant]\n${textParts}`)
    }

    // Include tool calls (truncated)
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const tool = part as { tool: string; state: { status: string; input?: unknown; output?: string; title?: string } }
      if (tool.state.status !== "completed") continue

      const input = JSON.stringify(tool.state.input ?? {}).slice(0, 200)
      const output = (tool.state.output ?? "").slice(0, 500)
      lines.push(`[tool: ${tool.tool}]\ninput: ${input}\noutput: ${output}`)
    }
  }

  return lines.join("\n\n")
}

/** Parse a single JSON memory line from the extraction LLM response. */
export function parseMemoryLine(
  line: string,
  sessionID: string,
  projectID: string,
): Memory | null {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith("{")) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  const type = parsed.type as MemoryType
  const title = parsed.title as string
  const content = parsed.content as string

  if (!type || !title || !content) return null

  const validTypes: MemoryType[] = ["episodic", "semantic", "procedural", "prospective"]
  if (!validTypes.includes(type)) return null

  return {
    id: newId(),
    session_id: sessionID,
    project_id: projectID,
    scope: (parsed.scope as MemoryScope) ?? "project",
    type,
    category: (parsed.category as string) ?? "general",
    topic: (parsed.topic as string) ?? "general",
    title: title.slice(0, 200),
    content,
    keywords: Array.isArray(parsed.keywords) ? (parsed.keywords as string[]) : [],
    importance: typeof parsed.importance === "number" ? parsed.importance : 0.5,
    created_at: now(),
    last_accessed: 0,
    access_count: 0,
    superseded_by: null,
  }
}
