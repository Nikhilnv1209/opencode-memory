// Extraction prompt + session API call for the memory plugin

import { existsSync, mkdirSync, copyFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

import type { PluginInput } from "@opencode-ai/plugin"
import type { Database } from "bun:sqlite"
import type { Message, Part } from "@opencode-ai/sdk"
import type { Memory } from "./schema.ts"
import { formatConversation, parseMemoryLine, estimateTokens } from "./utils.ts"
import { getManualMemories } from "./db.ts"

export interface ExtractOpts {
  models: {
    extraction: string | null
    consolidation: string | null
    personality: string | null
  }
  triggers: string[]
  contextBudget: number
  contextualInjection: boolean
  consolidateOnStart: boolean
  maxMemories: number
  maxConcurrentExtractions: number
}

/** Name of the custom extraction agent. Must match agent/memory-extraction.md filename. */
export const AGENT_NAME = "memory-extraction"

/** Ensure the global agent file exists (copies from bundled agent/ dir).
 * Runs at plugin init as a safety net — postinstall handles the normal case,
 * but this covers dev/local installs where postinstall didn't run.
 * Always overwrites to keep the agent in sync with the plugin version. */
export function ensureAgentFile(): void {
  const configDir = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "opencode",
  )
  const agentDir = join(configDir, "agent")
  const agentFile = join(agentDir, `${AGENT_NAME}.md`)
  const sourceFile = join(import.meta.dir, "..", "agent", `${AGENT_NAME}.md`)

  if (!existsSync(sourceFile)) return

  mkdirSync(agentDir, { recursive: true })
  copyFileSync(sourceFile, agentFile)
}

// Max tokens per extraction chunk. The extraction agent prompt is ~500 tokens,
// the user instruction ~50 tokens, and we need ~3K for model output.
// With 128K+ context windows, 60K leaves plenty of room.
const MAX_CHUNK_TOKENS = 60000

/**
 * Extract memories from a conversation.
 *
 * If the conversation is small enough (under MAX_CHUNK_TOKENS), extracts in one shot.
 * If it's larger, splits the conversation into chunks and extracts from each,
 * then merges all memories. This handles sessions where the conversation exceeds
 * the extraction model's context window.
 *
 * The temp session uses a custom "memory-extraction" agent:
 * - system prompt = extraction instructions (from ~/.config/opencode/agent/memory-extraction.md)
 * - all tools disabled (agent config: tools: { "*": false })
 * - steps: 1 (single response, no agentic loop)
 * - model = opts.models.extraction or user's default
 *
 * Why a temp session? The plugin API doesn't expose LLM.Service.stream() —
 * the internal mechanism that compaction/title generation use for session-less
 * LLM calls. The only LLM call available to plugins is via the session prompt API.
 */
export async function extractMemories(
  messages: Array<{ info: Message; parts: Part[] }>,
  input: PluginInput,
  opts: ExtractOpts,
  currentSessionID: string,
  projectID: string,
  extractionSessions: Set<string>,
  globalDb: Database,
  projectDb: Database,
): Promise<Memory[]> {
  if (messages.length === 0) return []

  const conversation = formatConversation(messages)
  if (!conversation.trim()) return []

  // Build signals from manually-added memories (shows the model what the user values)
  const manualMemories = getManualMemories(projectDb, projectID, 5)
  const signals = manualMemories.length > 0
    ? manualMemories.map((m) => `- ${m.title} (importance: ${m.importance})`).join("\n")
    : null

  const tokenEstimate = estimateTokens(conversation)

  // Small enough — single extraction
  if (tokenEstimate <= MAX_CHUNK_TOKENS) {
    return await extractChunk(conversation, input, opts, currentSessionID, projectID, extractionSessions, globalDb, signals)
  }

  // Too large — split into chunks and extract from each
  const chunks = chunkMessagesByTokens(messages, MAX_CHUNK_TOKENS)
  const allMemories: Memory[] = []

  for (const chunk of chunks) {
    if (input && typeof input === "object" && "_disposed" in input) break
    const chunkText = formatConversation(chunk)
    if (!chunkText.trim()) continue

    const chunkMemories = await extractChunk(
      chunkText, input, opts, currentSessionID, projectID, extractionSessions, globalDb, signals,
    )
    allMemories.push(...chunkMemories)
  }

  return allMemories
}

/** Split messages into chunks where each chunk's formatted text is under the token budget. */
function chunkMessagesByTokens(
  messages: Array<{ info: Message; parts: Part[] }>,
  maxTokens: number,
): Array<Array<{ info: Message; parts: Part[] }>> {
  const chunks: Array<Array<{ info: Message; parts: Part[] }>> = []
  let current: Array<{ info: Message; parts: Part[] }> = []
  let currentTokens = 0

  for (const msg of messages) {
    const msgText = formatConversation([msg])
    const msgTokens = estimateTokens(msgText)

    // If this single message exceeds the budget, skip it (can't extract from it anyway)
    if (msgTokens > maxTokens) continue

    if (currentTokens + msgTokens > maxTokens && current.length > 0) {
      chunks.push(current)
      current = [msg]
      currentTokens = msgTokens
    } else {
      current.push(msg)
      currentTokens += msgTokens
    }
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Extract memories from a single conversation chunk via a temp session. */
async function extractChunk(
  conversation: string,
  input: PluginInput,
  opts: ExtractOpts,
  currentSessionID: string,
  projectID: string,
  extractionSessions: Set<string>,
  globalDb: Database,
  signals: string | null,
): Promise<Memory[]> {
  // Create a temporary session for extraction
  const createResult = await input.client.session.create({
    body: { title: "memory-extraction" },
    query: { directory: input.directory },
  })
  const tempSession = createResult.data
  if (!tempSession) return []

  const tempSessionID = tempSession.id
  extractionSessions.add(tempSessionID)
  globalDb.run("INSERT OR IGNORE INTO extraction_sessions (session_id, created_at) VALUES (?, ?)", [tempSessionID, Date.now()])

  try {
    const instruction = signals
      ? `Extract memories from the conversation below as JSON lines. Do NOT continue or answer the conversation. Output ONLY JSON memory lines.\n\n<signals>\nMemories the user manually created — match this style and depth:\n${signals}\n</signals>\n\n${conversation}`
      : `Extract memories from the conversation below as JSON lines. Do NOT continue or answer the conversation. Output ONLY JSON memory lines.\n\n${conversation}`

    const body: {
      parts: Array<{ type: "text"; text: string }>
      agent: string
      model?: { providerID: string; modelID: string }
    } = {
      agent: AGENT_NAME,
      parts: [{ type: "text", text: instruction }],
    }

    if (opts.models.extraction) {
      const [providerID, ...modelParts] = opts.models.extraction.split("/")
      body.model = { providerID, modelID: modelParts.join("/") }
    }

    // 120s timeout — extraction should never take longer
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Extraction timed out")), 120000),
    )

    const promptResult = await Promise.race([
      input.client.session.prompt({
        path: { id: tempSessionID },
        body,
        query: { directory: input.directory },
      }),
      timeout,
    ]).catch(() => null)

    if (!promptResult?.data) return []

    const responseText = (promptResult.data.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n")

    if (!responseText.trim()) return []

    const memories: Memory[] = []
    for (const line of responseText.split("\n")) {
      const mem = parseMemoryLine(line, currentSessionID, projectID)
      if (mem) memories.push(mem)
    }

    return memories
  } finally {
    await input.client.session
      .delete({ path: { id: tempSessionID }, query: { directory: input.directory } })
      .catch(() => {})

    setTimeout(() => extractionSessions.delete(tempSessionID), 60000)
  }
}
