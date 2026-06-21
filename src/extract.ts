// Extraction prompt + session API call for the memory plugin

import type { PluginInput } from "@opencode-ai/plugin"
import type { Database } from "bun:sqlite"
import type { Message, Part } from "@opencode-ai/sdk"
import type { Memory } from "./schema.ts"
import { formatConversation, parseMemoryLine, estimateTokens } from "./utils.ts"

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

const EXTRACTION_PROMPT = `You are a memory extraction system for an AI agent.
The agent may be used for coding, research, writing, analysis, or any other task.
Given the conversation below, extract DURABLE, MEANINGFUL knowledge
that would help a future session work more effectively on this project
or with this user.

For each memory worth saving, output a JSON object on its own line:
{"scope":"project|personality","type":"episodic|semantic|procedural|prospective","category":"free-form","topic":"kebab-case","title":"Short with file paths (max 80 chars)","content":"Full description","keywords":["tag1","tag2"],"importance":0.0-1.0}

CONTENT MUST INCLUDE (when applicable):
- INTENT: What was the user trying to accomplish?
- ROOT CAUSE: If a bug was fixed, what was the actual root cause?
- DECISION: What was decided and why?
- EVIDENCE: File paths, line numbers, function names
- PATTERN: Any recurring issues or anti-patterns noticed?

SCOPE RULES:
- "personality" = about the USER (working style, preferences, universal habits)
- "project" = about THIS codebase (bugs, features, build commands, decisions)
- When in doubt, use "project"

CLASSIFY THE CONVERSATION BEFORE EXTRACTING:

1. IMPLEMENTATION — user asked the agent to write code, edit files, or run commands.
   Look for: [tool: edit], [tool: write], [tool: bash] with action commands.
   Use: type="episodic", category="feature" or "bugfix" or "refactor"
   Importance: 0.7-0.9

2. RESEARCH — user was asking questions, exploring ideas, investigating a topic.
   Look for: user messages that ask "what", "how", "why", "can we", "what if".
   The assistant EXPLAINS or DISCUSSES — no files were edited, no code was written.
   Use: type="episodic", category="research" or "finding"
   Importance: 0.3-0.5 (research is useful context but not work done)
   Title MUST start with "Research:" or "Explored:" to distinguish from implementation.

3. DECISION — user made a specific decision about how to proceed.
   Look for: user says "let's go with X", "we'll use Y", "decision is Z".
   Use: type="semantic", category="decision"
   Importance: 0.6-0.8

4. PREFERENCE — user expressed how they like to work.
   Use: scope="personality", type="semantic", category="preference"
   Importance: 0.5-0.7

CRITICAL — DO NOT CONFUSE RESEARCH WITH IMPLEMENTATION:
- If the user asked "what DNS records prove ownership?" and the assistant explained
  CAA records, DKIM CNAMEs, and TLS SANs — that is RESEARCH, not implementation.
  Title: "Research: DNS signals for domain ownership verification"
  NOT: "Built DNS verification system" or "Detecting MS365 DKIM CNAME records"
- If the user asked "how does X work?" and the agent explained — that is RESEARCH.
- Only classify as implementation if files were actually edited or code was written.
- The assistant's explanation of a concept is NOT the user building that concept.

OTHER RULES:
- Only extract genuinely useful memories. Skip trivial turns (greetings, "ok", "thanks").
- Capture WHY, not just WHAT.
- If the user corrected the agent, capture the correction AND what was wrong.
- If work is unfinished, capture what remains and the plan.
- Don't extract things already in AGENTS.md.
- Use the SAME topic as previous sessions if this is continuation work.
- Prefer fewer, richer memories over many shallow ones. When in doubt, skip.
- Output each memory as a single line of JSON.
`

// Max tokens per extraction chunk. Leaves room for system prompt (~500 tokens)
// and model output (~3K tokens) within a typical 128K+ context window.
const MAX_CHUNK_TOKENS = 20000

/**
 * Extract memories from a conversation.
 *
 * If the conversation is small enough (under MAX_CHUNK_TOKENS), extracts in one shot.
 * If it's larger, splits the conversation into chunks and extracts from each,
 * then merges all memories. This handles sessions where the conversation exceeds
 * the extraction model's context window.
 *
 * The temp session is lightweight:
 * - system prompt = extraction instructions (not the default agent prompt)
 * - all tools explicitly disabled
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
  disabledTools: Record<string, boolean>,
): Promise<Memory[]> {
  if (messages.length === 0) return []

  const conversation = formatConversation(messages)
  if (!conversation.trim()) return []

  const tokenEstimate = estimateTokens(conversation)

  // Small enough — single extraction
  if (tokenEstimate <= MAX_CHUNK_TOKENS) {
    return await extractChunk(conversation, input, opts, currentSessionID, projectID, extractionSessions, globalDb, disabledTools)
  }

  // Too large — split into chunks and extract from each
  const chunks = chunkMessagesByTokens(messages, MAX_CHUNK_TOKENS)
  const allMemories: Memory[] = []

  for (const chunk of chunks) {
    if (input && typeof input === "object" && "_disposed" in input) break
    const chunkText = formatConversation(chunk)
    if (!chunkText.trim()) continue

    const chunkMemories = await extractChunk(
      chunkText, input, opts, currentSessionID, projectID, extractionSessions, globalDb, disabledTools,
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
  disabledTools: Record<string, boolean>,
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
    const body: {
      parts: Array<{ type: "text"; text: string }>
      system: string
      tools: Record<string, boolean>
      model?: { providerID: string; modelID: string }
    } = {
      system: EXTRACTION_PROMPT,
      parts: [{ type: "text", text: conversation }],
      tools: disabledTools,
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
