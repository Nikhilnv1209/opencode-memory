// Extraction prompt + session API call for the memory plugin

import type { PluginInput } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"
import type { Memory } from "./schema.ts"
import { formatConversation, parseMemoryLine } from "./utils.ts"

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

CATEGORY is free-form — use whatever best describes the memory:
  Coding: bugfix, feature, refactor, config, build, test
  Research: finding, hypothesis, source, methodology, dead-end
  Writing: draft, edit, structure, style
  General: pattern, preference, unfinished, decision, correction
  You may create new categories as needed.

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

RULES:
- Only extract genuinely useful memories. Skip trivial turns (greetings, "ok", "thanks").
- Capture WHY, not just WHAT.
- If the user corrected the agent, capture the correction AND what was wrong.
- If work is unfinished, capture what remains and the plan.
- Don't extract things already in AGENTS.md.
- Use the SAME topic as previous sessions if this is continuation work.
- Prefer fewer, richer memories over many shallow ones.
- Output each memory as a single line of JSON.
`

/**
 * Extract memories from a conversation by creating a temporary session,
 * sending the extraction prompt, and parsing the response.
 *
 * The temp session is lightweight:
 * - system prompt = extraction instructions (not the default agent prompt)
 * - tools = {} (no tools loaded — saves tokens, no tool schemas sent)
 * - model = opts.models.extraction or user's default
 *
 * The temp session ID is added to extractionSessions BEFORE the prompt is sent
 * so that all plugin hooks (system.transform, compacting, event) can detect and
 * skip it — preventing a recursive extraction loop.
 *
 * Why a temp session instead of a direct LLM call?
 * The plugin API (PluginInput) doesn't expose LLM.Service.stream() — the internal
 * mechanism that compaction and title generation use for session-less LLM calls.
 * The only LLM call available to plugins is via the session prompt HTTP API.
 * This is a limitation of the current plugin V1 interface, not a design choice.
 */
export async function extractMemories(
  messages: Array<{ info: Message; parts: Part[] }>,
  input: PluginInput,
  opts: ExtractOpts,
  currentSessionID: string,
  projectID: string,
  extractionSessions: Set<string>,
): Promise<Memory[]> {
  if (messages.length === 0) return []

  const conversation = formatConversation(messages)
  if (!conversation.trim()) return []

  // Create a temporary session for extraction
  const createResult = await input.client.session.create({
    body: { title: "memory-extraction" },
    query: { directory: input.directory },
  })
  const tempSession = createResult.data
  if (!tempSession) return []

  const tempSessionID = tempSession.id
  // Register BEFORE sending the prompt so hooks can skip this session
  extractionSessions.add(tempSessionID)

  try {
    // Build the prompt body — lightweight session with no tools
    const body: {
      parts: Array<{ type: "text"; text: string }>
      system: string
      tools: Record<string, never>
      model?: { providerID: string; modelID: string }
    } = {
      // Extraction instructions go in the system prompt
      system: EXTRACTION_PROMPT,
      // Conversation goes as the user message
      parts: [{ type: "text", text: conversation }],
      // Disable all tools — extraction is text-only
      tools: {},
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

    // Extract text from the assistant response
    const responseText = (promptResult.data.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n")

    if (!responseText.trim()) return []

    // Parse JSON memory lines from the response
    const memories: Memory[] = []
    for (const line of responseText.split("\n")) {
      const mem = parseMemoryLine(line, currentSessionID, projectID)
      if (mem) memories.push(mem)
    }

    return memories
  } finally {
    // Delete the temp session
    await input.client.session
      .delete({ path: { id: tempSessionID }, query: { directory: input.directory } })
      .catch(() => {})

    // Keep the ID in extractionSessions for 60s to catch any late-arriving
    // session.idle events for the deleted session
    setTimeout(() => extractionSessions.delete(tempSessionID), 60000)
  }
}
