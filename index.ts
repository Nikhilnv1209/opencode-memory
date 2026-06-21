import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

import type { Plugin } from "@opencode-ai/plugin"

import { GLOBAL_SCHEMA } from "./src/schema.ts"
import { initDb, storeMemory, getRecentMemoriesDecayed, getTopicIndex, pruneMemories } from "./src/db.ts"
import { extractMemories, type ExtractOpts } from "./src/extract.ts"
import { generatePrimer, generateIndex } from "./src/primer.ts"
import { hashDir } from "./src/utils.ts"

export default (async (ctx, options) => {
  // --- Storage setup ---
  const opencodeDir = join(homedir(), ".opencode")
  const memoryDir = join(opencodeDir, "memory")
  const projectDir = join(memoryDir, "projects", hashDir(ctx.worktree))
  mkdirSync(projectDir, { recursive: true })

  const db = initDb(join(projectDir, "memory.db"))

  const globalDb = new Database(join(memoryDir, "global.db"))
  globalDb.exec("PRAGMA journal_mode = WAL")
  globalDb.exec(GLOBAL_SCHEMA)

  const personalityPath = join(opencodeDir, "personality.md")

  // --- State ---
  // Tracks temp extraction session IDs so all hooks can skip them,
  // preventing a recursive extraction loop.
  const extractionSessions = new Set<string>()

  // Prevents database access after dispose closes the handles.
  let disposed = false

  // Prevents concurrent extractions (e.g. compaction + session.idle racing).
  let extracting = false

  // --- Parse options ---
  const raw = (options ?? {}) as Record<string, unknown>
  const opts: ExtractOpts = {
    models: (raw.models as ExtractOpts["models"]) ?? {
      extraction: null,
      consolidation: null,
      personality: null,
    },
    triggers: (raw.triggers as string[]) ?? ["compaction", "session-end"],
    contextBudget: (raw.contextBudget as number) ?? 800,
    contextualInjection: (raw.contextualInjection as boolean) ?? true,
    consolidateOnStart: (raw.consolidateOnStart as boolean) ?? true,
    maxMemories: (raw.maxMemories as number) ?? 500,
  }

  /** Run extraction, guarding against recursion, concurrency, and disposed state. */
  async function runExtraction(sessionID: string) {
    if (disposed || extracting) return
    if (extractionSessions.has(sessionID)) return

    extracting = true
    try {
      const result = await ctx.client.session.messages({ path: { id: sessionID } })
      const messages = result.data ?? []
      if (messages.length === 0) return

      const memories = await extractMemories(
        messages, ctx, opts, sessionID, ctx.worktree, extractionSessions,
      )

      if (disposed) return

      // Filter out near-zero importance (junk from trivial conversations)
      const worthKeeping = memories.filter((m) => m.importance >= 0.1)
      for (const mem of worthKeeping) {
        storeMemory(db, mem)
      }
      pruneMemories(db, ctx.worktree, opts.maxMemories)
    } catch (err) {
      console.error("[memory] Extraction failed:", err)
    } finally {
      extracting = false
    }
  }

  return {
    // 1. INJECT: personality + primer + index (within contextBudget)
    "experimental.chat.system.transform": async (req, output) => {
      // Skip injection for extraction sessions — don't pollute the extraction prompt
      if (req.sessionID && extractionSessions.has(req.sessionID)) return
      if (disposed) return

      try {
        // Personality (global, always — highest budget priority)
        const personalityFile = Bun.file(personalityPath)
        if (await personalityFile.exists()) {
          const personality = await personalityFile.text()
          if (personality.trim()) output.system.push(personality)
        }

        // Primer (recent work, active topics, unfinished)
        const recent = getRecentMemoriesDecayed(db, ctx.worktree, 10)
        const primerBudget = Math.floor(opts.contextBudget * 0.4)
        const primer = generatePrimer(recent, primerBudget)
        if (primer) output.system.push(primer)

        // Memory index (compact list of all topics)
        const topics = getTopicIndex(db, ctx.worktree)
        const index = generateIndex(topics)
        if (index) output.system.push(index)
      } catch (err) {
        console.error("[memory] Injection failed:", err)
      }
    },

    // 2. EXTRACT at compaction (last chance before data loss)
    "experimental.session.compacting": async (req) => {
      if (!opts.triggers.includes("compaction")) return
      if (extractionSessions.has(req.sessionID)) return
      await runExtraction(req.sessionID)
    },

    // 3. EXTRACT at session idle
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      if (!opts.triggers.includes("session-end")) return

      const sessionID = (event.properties as { sessionID?: string })?.sessionID
      if (!sessionID) return
      if (extractionSessions.has(sessionID)) return
      await runExtraction(sessionID)
    },

    // 4. CLEANUP
    dispose: async () => {
      disposed = true
      db.close()
      globalDb.close()
    },
  }
}) as Plugin
