import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

import { GLOBAL_SCHEMA } from "./src/schema.ts"
import {
  initDb, storeMemory, getRecentMemoriesDecayed, getTopicIndex,
  pruneMemories, countMemoriesBySession, searchMemories, boostAccessed,
} from "./src/db.ts"
import { extractMemories, type ExtractOpts } from "./src/extract.ts"
import { generatePrimer, generateIndex } from "./src/primer.ts"
import { hashDir } from "./src/utils.ts"

/**
 * Simple semaphore for limiting concurrent extractions.
 * maxConcurrent=1 means sequential (default).
 * maxConcurrent=N means up to N extractions can run in parallel.
 */
class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(max: number) {
    this.available = max
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.available--
  }

  release(): void {
    this.available++
    const next = this.waiters.shift()
    if (next) next()
  }
}

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
  const extractionSessions = new Set<string>()
  const extractingSessions = new Set<string>()
  let disposed = false

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
    maxConcurrentExtractions: (raw.maxConcurrentExtractions as number) ?? 1,
  }

  const semaphore = new Semaphore(opts.maxConcurrentExtractions)

  /** Check if a session ID is a known extraction session (temp session created by this plugin). */
  function isExtractionSession(sessionID: string): boolean {
    if (extractionSessions.has(sessionID)) return true
    const row = globalDb.query("SELECT 1 FROM extraction_sessions WHERE session_id = ?").get(sessionID)
    return !!row
  }

  /** Cached map of all tool IDs set to false (disabled).
   *  Fetched once from the server, reused for all extraction sessions. */
  let cachedDisabledTools: Record<string, boolean> | null = null

  async function getDisabledTools(): Promise<Record<string, boolean>> {
    if (cachedDisabledTools) return cachedDisabledTools
    try {
      const result = await ctx.client.tool.ids()
      const ids = result.data ?? []
      cachedDisabledTools = {}
      for (const id of ids) {
        cachedDisabledTools[id] = false
      }
    } catch {
      // If tool.ids() fails, fall back to disabling common tools by name
      cachedDisabledTools = {
        bash: false, edit: false, read: false, write: false,
        grep: false, glob: false, task: false, webfetch: false,
        todowrite: false, question: false, skill: false,
        list: false, lsp: false, memory_backfill: false, memory_search: false,
      }
    }
    return cachedDisabledTools
  }

  /**
   * Extract memories from a single session.
   * Uses the semaphore to limit concurrency (default: 1 = sequential).
   * The extraction model is set via opts.models.extraction (null = user's default).
   */
  async function runExtraction(sessionID: string) {
    if (disposed) return
    if (isExtractionSession(sessionID)) return
    if (extractingSessions.has(sessionID)) return

    extractingSessions.add(sessionID)
    await semaphore.acquire()

    try {
      if (disposed) return

      const result = await ctx.client.session.messages({ path: { id: sessionID } })
      const messages = result.data ?? []
      if (messages.length === 0) return

      const disabledTools = await getDisabledTools()

      const memories = await extractMemories(
        messages, ctx, opts, sessionID, ctx.worktree, extractionSessions, globalDb, disabledTools,
      )

      if (disposed) return

      const worthKeeping = memories.filter((m) => m.importance >= 0.1)
      for (const mem of worthKeeping) {
        storeMemory(db, mem)
      }
      pruneMemories(db, ctx.worktree, opts.maxMemories)
    } catch (err) {
      console.error("[memory] Extraction failed:", err)
    } finally {
      semaphore.release()
      extractingSessions.delete(sessionID)
    }
  }

  /**
   * Backfill memories from a list of sessions.
   * Fires all sessions at once — the semaphore limits actual concurrency.
   * With maxConcurrentExtractions=1 (default), sessions are processed sequentially.
   * With maxConcurrentExtractions=3, up to 3 sessions are extracted in parallel.
   */
  async function backfillFromList(sessionIDs: string[]): Promise<{ processed: number; extracted: number }> {
    let processed = 0
    let extracted = 0

    const results = await Promise.all(
      sessionIDs.map(async (sessionID) => {
        if (disposed) return
        if (isExtractionSession(sessionID)) return
        if (extractingSessions.has(sessionID)) return
        if (countMemoriesBySession(db, sessionID) > 0) return

        extractingSessions.add(sessionID)
        await semaphore.acquire()

        try {
          if (disposed) return

          const result = await ctx.client.session.messages({ path: { id: sessionID } })
          const messages = result.data ?? []
          if (messages.length === 0) return

          const disabledTools = await getDisabledTools()

          const memories = await extractMemories(
            messages, ctx, opts, sessionID, ctx.worktree, extractionSessions, globalDb, disabledTools,
          )

          if (disposed) return

          const worthKeeping = memories.filter((m) => m.importance >= 0.1)
          for (const mem of worthKeeping) {
            storeMemory(db, mem)
          }

          return { processed: 1, extracted: worthKeeping.length }
        } catch (err) {
          console.error("[memory] Backfill failed for session", sessionID, err)
          return
        } finally {
          semaphore.release()
          extractingSessions.delete(sessionID)
        }
      }),
    )

    for (const r of results) {
      if (r) {
        processed += r.processed
        extracted += r.extracted
      }
    }

    if (!disposed) pruneMemories(db, ctx.worktree, opts.maxMemories)
    return { processed, extracted }
  }

  return {
    // 1. INJECT: personality + primer + index (within contextBudget)
    "experimental.chat.system.transform": async (req, output) => {
      if (req.sessionID && isExtractionSession(req.sessionID)) return
      if (disposed) return

      try {
        const personalityFile = Bun.file(personalityPath)
        if (await personalityFile.exists()) {
          const personality = await personalityFile.text()
          if (personality.trim()) output.system.push(personality)
        }

        const recent = getRecentMemoriesDecayed(db, ctx.worktree, 10)
        const primerBudget = Math.floor(opts.contextBudget * 0.4)
        const primer = generatePrimer(recent, primerBudget)
        if (primer) output.system.push(primer)

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
      if (isExtractionSession(req.sessionID)) return
      await runExtraction(req.sessionID)
    },

    // 3. EXTRACT at session idle
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      if (!opts.triggers.includes("session-end")) return

      const sessionID = (event.properties as { sessionID?: string })?.sessionID
      if (!sessionID) return
      if (isExtractionSession(sessionID)) return
      await runExtraction(sessionID)
    },

    // 4. TOOLS
    tool: {
      // Backfill memories from previous sessions (user-controlled)
      memory_backfill: tool({
        description:
          "Backfill memories from previous sessions. Without args: lists sessions that haven't been processed yet. With sessionIDs: processes those specific sessions. With all=true: processes all unprocessed sessions (up to limit). Extraction runs in the background.",
        args: {
          sessionIDs: tool.schema.array(tool.schema.string()).optional().describe("Specific session IDs to backfill"),
          all: tool.schema.boolean().optional().describe("Backfill all unprocessed sessions"),
          limit: tool.schema.number().optional().describe("Max sessions to process when all=true (default 10)"),
        },
        async execute(args) {
          if (disposed) return { output: "Plugin is disposed, cannot backfill." }

          // List mode: show unprocessed sessions
          if (!args.sessionIDs && !args.all) {
            const result = await ctx.client.session.list({ query: { directory: ctx.directory } })
            const sessions = (result.data ?? [])
              .filter((s) => s.directory === ctx.directory)
              .filter((s) => !isExtractionSession(s.id))
              .sort((a, b) => b.time.created - a.time.created)

            const unprocessed: Array<{ id: string; title: string; created: string }> = []
            for (const s of sessions) {
              if (countMemoriesBySession(db, s.id) === 0) {
                unprocessed.push({
                  id: s.id,
                  title: s.title,
                  created: new Date(s.time.created).toISOString().slice(0, 10),
                })
              }
            }

            if (unprocessed.length === 0) {
              return { output: "All sessions have already been processed. No backfill needed." }
            }

            const lines = unprocessed.slice(0, 20).map(
              (s, i) => `${i + 1}. [${s.created}] ${s.title}\n   id: ${s.id}`,
            )

            return {
              output:
                `Found ${unprocessed.length} session(s) without memories:\n\n` +
                lines.join("\n") +
                `\n\nTo backfill: call memory_backfill with sessionIDs=["id1","id2"] for specific sessions, or all=true for all.`,
            }
          }

          // Determine which sessions to process
          const result = await ctx.client.session.list({ query: { directory: ctx.directory } })
          const allSessions = (result.data ?? [])
            .filter((s) => s.directory === ctx.directory)
            .filter((s) => !isExtractionSession(s.id))
            .sort((a, b) => b.time.created - a.time.created)

          let targets: string[]

          if (args.all) {
            const limit = args.limit ?? 10
            targets = allSessions
              .filter((s) => countMemoriesBySession(db, s.id) === 0)
              .slice(0, limit)
              .map((s) => s.id)
          } else {
            const idSet = new Set(args.sessionIDs!)
            targets = allSessions.filter((s) => idSet.has(s.id)).map((s) => s.id)
          }

          if (targets.length === 0) {
            return { output: "No sessions to backfill." }
          }

          // Run in background — doesn't block the agent
          void backfillFromList(targets)

          return {
            output:
              `Backfill started for ${targets.length} session(s) in the background. ` +
              `Memories will appear as they're extracted. Use memory_backfill (no args) again to check progress.`,
          }
        },
      }),

      // Search stored memories
      memory_search: tool({
        description:
          "Search cross-session memory for past work, decisions, patterns, and unfinished tasks",
        args: {
          query: tool.schema.string().describe("What to search for"),
          topic: tool.schema.string().optional().describe("Filter by topic"),
          limit: tool.schema.number().optional().describe("Max results, default 5"),
        },
        async execute(args) {
          if (disposed) return { output: "Plugin is disposed, cannot search." }

          const results = searchMemories(db, {
            query: args.query,
            topic: args.topic,
            projectId: ctx.worktree,
            limit: args.limit ?? 5,
          })

          if (results.length === 0) {
            return { output: "No memories found matching your query." }
          }

          boostAccessed(
            db,
            results.map((r) => r.id),
          )

          return {
            output: results
              .map((m) => `[${m.type}/${m.scope}] ${m.title}\n${m.content}\nKeywords: ${(m.keywords ?? []).join(", ")}`)
              .join("\n\n---\n\n"),
          }
        },
      }),
    },

    // 5. CLEANUP
    dispose: async () => {
      disposed = true
      db.close()
      globalDb.close()
    },
  }
}) as Plugin
