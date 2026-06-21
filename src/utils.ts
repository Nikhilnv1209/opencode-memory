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

/** Tools that only read information — skip entirely. */
const READ_ONLY_TOOLS = new Set([
  "grep", "read", "glob", "find", "list", "lsp", "skill", "task",
  "todowrite", "question", "webfetch", "github-triage", "github-pr-search",
])

/** Bash command patterns that are informational only — skip. */
const INFORMATIONAL_BASH = /^(ls|cat|head|tail|wc|sort|uniq|cut|tr|awk|sed|diff|file|stat|du|df|ps|whoami|pwd|echo|which|whereis|man|help|history|id|uname|hostname|date|uptime|env|printenv|find|grep|rg|fd|xargs|git\s+(log|show|diff|status|branch))\b/

/** Format conversation messages for the extraction prompt.
 *
 * Passes user messages, assistant text responses, and action tool calls.
 * Tool OUTPUTS are never included — they cause false memories (e.g. git log
 * commit messages get extracted as "work the user did").
 *
 * Tool INPUTS are included only for action tools:
 * - edit/write: includes the file path (what was changed)
 * - bash: includes the command text, but skips informational commands
 *   (ls, cat, grep, git log, etc. — the agent already summarized these)
 * - Read-only tools (grep, read, glob, find, etc.): skipped entirely
 */
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

    // Include action tool calls — inputs only, never outputs
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const toolPart = part as {
        tool: string
        state: { status: string; input?: Record<string, unknown> }
      }
      if (toolPart.state.status !== "completed") continue

      const toolName = toolPart.tool
      const input = toolPart.state.input ?? {}

      // Skip read-only tools entirely
      if (READ_ONLY_TOOLS.has(toolName)) continue

      if (toolName === "edit" || toolName === "write") {
        const filePath = (input as { filePath?: string }).filePath
        if (filePath) lines.push(`[tool: ${toolName}] ${filePath}`)
      } else if (toolName === "bash") {
        const command = (input as { command?: string }).command ?? ""
        if (command && !INFORMATIONAL_BASH.test(command.trim())) {
          lines.push(`[tool: bash] ${command.slice(0, 200)}`)
        }
      }
    }
  }

  return lines.join("\n\n")
}

/** Parse a single JSON memory line from the extraction LLM response.
 * Handles lines that may be wrapped in markdown code blocks. */
export function parseMemoryLine(
  line: string,
  sessionID: string,
  projectID: string,
): Memory | null {
  let trimmed = line.trim()
  if (!trimmed) return null

  // Strip markdown code block markers
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
  }

  // Extract first JSON object on the line
  const start = trimmed.indexOf("{")
  if (start === -1) return null
  const end = trimmed.lastIndexOf("}")
  if (end === -1 || end < start) return null
  const jsonStr = trimmed.slice(start, end + 1)

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr)
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
