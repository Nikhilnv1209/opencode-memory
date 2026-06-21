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
import { extractMemories, type ExtractOpts, ensureAgentFile } from "./src/extract.ts"
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

/** Format backfill progress as readable text. */
interface BackfillStatus {
  running: boolean
  total: number
  processed: number
  extracted: number
  errors: number
  startedAt: number
  finishedAt: number | null
  currentTitle: string | null
}

function formatBackfillStatus(s: BackfillStatus): string {
  const pct = s.total > 0 ? Math.round((s.processed / s.total) * 100) : 0
  const elapsed = Math.round(((s.finishedAt ?? Date.now()) - s.startedAt) / 1000)

  const lines = [
    `Progress: ${s.processed}/${s.total} sessions (${pct}%)`,
    `Memories extracted: ${s.extracted}`,
  ]

  if (s.errors > 0) lines.push(`Errors: ${s.errors}`)
  lines.push(`Time: ${elapsed}s`)

  if (s.running && s.currentTitle) {
    lines.push(`Currently processing: ${s.currentTitle}`)
  }

  if (!s.running && s.finishedAt) {
    lines.push(`Status: completed`)
  }

  return lines.join("\n")
}

export default (async (ctx, options) => {
  // --- Ensure extraction agent is installed globally ---
  ensureAgentFile()

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
  let lastActiveSessionID: string | null = null
  let disposed = false

  // --- Parse options ---
  const raw = (options ?? {}) as Record<string, unknown>
  const opts: ExtractOpts = {
    models: (raw.models as ExtractOpts["models"]) ?? {
      extraction: null,
      consolidation: null,
      personality: null,
    },
    triggers: (raw.triggers as string[]) ?? ["compaction", "session-switch"],
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

  /** Backfill progress tracker. */
  let backfillStatus: BackfillStatus | null = null

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

      const memories = await extractMemories(
        messages, ctx, opts, sessionID, ctx.worktree, extractionSessions, globalDb,
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
   * Backfill memories from a list of sessions sequentially.
   * Updates backfillStatus so the tool can report progress.
   * Respects the semaphore (waits if a normal extraction is running).
   */
  async function backfillFromList(
    sessions: Array<{ id: string; title: string }>,
  ): Promise<void> {
    backfillStatus = {
      running: true,
      total: sessions.length,
      processed: 0,
      extracted: 0,
      errors: 0,
      startedAt: Date.now(),
      finishedAt: null,
      currentTitle: null,
    }

    for (const session of sessions) {
      if (disposed) break

      // Skip extraction sessions and already-processed sessions
      if (isExtractionSession(session.id) ||
          extractingSessions.has(session.id) ||
          countMemoriesBySession(db, session.id) > 0) {
        backfillStatus.processed++
        continue
      }

      backfillStatus.currentTitle = session.title
      extractingSessions.add(session.id)
      await semaphore.acquire()

      try {
        if (disposed) break

        const result = await ctx.client.session.messages({ path: { id: session.id } })
        const messages = result.data ?? []
        if (messages.length === 0) {
          backfillStatus.processed++
          continue
        }

        const memories = await extractMemories(
          messages, ctx, opts, session.id, ctx.worktree, extractionSessions, globalDb,
        )

        if (disposed) break

        const worthKeeping = memories.filter((m) => m.importance >= 0.1)
        for (const mem of worthKeeping) {
          storeMemory(db, mem)
        }

        backfillStatus.processed++
        backfillStatus.extracted += worthKeeping.length
      } catch (err) {
        console.error("[memory] Backfill failed for session", session.id, err)
        backfillStatus.errors++
        backfillStatus.processed++
      } finally {
        semaphore.release()
        extractingSessions.delete(session.id)
      }
    }

    if (!disposed) pruneMemories(db, ctx.worktree, opts.maxMemories)

    backfillStatus.running = false
    backfillStatus.finishedAt = Date.now()
    backfillStatus.currentTitle = null
  }

  return {
    // 1. INJECT: personality + primer + index (within contextBudget)
    //    Also detects session switches for extraction
    "experimental.chat.system.transform": async (req, output) => {
      if (req.sessionID && isExtractionSession(req.sessionID)) return
      if (disposed) return

      // Detect session switch — extract from the previous session
      if (opts.triggers.includes("session-switch") &&
          lastActiveSessionID &&
          lastActiveSessionID !== req.sessionID &&
          !isExtractionSession(lastActiveSessionID)) {
        void runExtraction(lastActiveSessionID)
      }
      lastActiveSessionID = req.sessionID

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

    // 3. TOOLS
    tool: {
      // Backfill memories from previous sessions (user-controlled)
      memory_backfill: tool({
        description:
          "Backfill memories from previous sessions. Without args: lists unprocessed sessions with options. With sessionIDs: processes those specific sessions. With all=true: processes all unprocessed sessions (up to limit). With status=true: shows only the current progress. Blocks until completion and returns the result.",
        args: {
          sessionIDs: tool.schema.array(tool.schema.string()).optional().describe("Specific session IDs to backfill"),
          all: tool.schema.boolean().optional().describe("Backfill all unprocessed sessions"),
          limit: tool.schema.number().optional().describe("Max sessions to process when all=true (default 10)"),
          status: tool.schema.boolean().optional().describe("Only show backfill progress, don't list sessions or start backfill"),
        },
        async execute(args) {
          if (disposed) return { output: "Plugin is disposed, cannot backfill." }

          // Status-only mode: just report progress
          if (args.status) {
            if (!backfillStatus || (!backfillStatus.running && !backfillStatus.finishedAt)) {
              return { output: "No backfill has been run yet." }
            }
            return { output: formatBackfillStatus(backfillStatus) }
          }

          // If backfill is running, report progress instead of listing sessions
          if (backfillStatus?.running) {
            return {
              output:
                `Backfill is currently running.\n\n` +
                formatBackfillStatus(backfillStatus) +
                `\n\nWait for it to finish, or call memory_backfill with status=true to check again later.`,
            }
          }

          // Show results of last completed backfill (if recently finished)
          if (backfillStatus?.finishedAt && Date.now() - backfillStatus.finishedAt < 60000) {
            const lastResult = formatBackfillStatus(backfillStatus)
            backfillStatus = null // Clear so next call shows session list
            return {
              output: `Last backfill completed:\n\n${lastResult}\n\n---\n\n`,
            }
          }

          backfillStatus = null

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
                `\n\nOPTIONS — ask the user:\n` +
                `- "Backfill ALL sessions" → call memory_backfill with all=true\n` +
                `- "Backfill specific sessions" → ask user which numbers (e.g. "1 and 3"), ` +
                `then call memory_backfill with sessionIDs=["id1","id2"]\n` +
                `After starting, call memory_backfill with status=true to check progress.`,
            }
          }

          // Determine which sessions to process
          const result = await ctx.client.session.list({ query: { directory: ctx.directory } })
          const allSessions = (result.data ?? [])
            .filter((s) => s.directory === ctx.directory)
            .filter((s) => !isExtractionSession(s.id))
            .sort((a, b) => b.time.created - a.time.created)

          let targets: Array<{ id: string; title: string }>

          if (args.all) {
            const limit = args.limit ?? 10
            targets = allSessions
              .filter((s) => countMemoriesBySession(db, s.id) === 0)
              .slice(0, limit)
              .map((s) => ({ id: s.id, title: s.title }))
          } else {
            const idSet = new Set(args.sessionIDs!)
            targets = allSessions
              .filter((s) => idSet.has(s.id))
              .map((s) => ({ id: s.id, title: s.title }))
          }

          if (targets.length === 0) {
            return { output: "No sessions to backfill." }
          }

          await backfillFromList(targets)

          return { output: formatBackfillStatus(backfillStatus!) }
        },
      }),

      // List all memories (no search query needed)
      memory_list: tool({
        description:
          "List all stored memories. Use this when the user asks to see all memories or what's been extracted. Returns memories sorted by importance.",
        args: {
          limit: tool.schema.number().optional().describe("Max results, default 50"),
        },
        async execute(args) {
          if (disposed) return { output: "Plugin is disposed." }

          const limit = args.limit ?? 50
          const memories = getRecentMemoriesDecayed(db, ctx.worktree, limit)

          if (memories.length === 0) {
            return { output: "No memories stored yet." }
          }

          return {
            output: memories
              .map((m, i) =>
                `${i + 1}. [${m.type}/${m.scope}] ${m.title}\n   ${m.content.slice(0, 200)}\n   Keywords: ${(m.keywords ?? []).join(", ")} | Importance: ${m.importance}`,
              )
              .join("\n\n"),
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

    // 4. CLEANUP — extract from last active session, then close
    dispose: async () => {
      if (opts.triggers.includes("session-switch") &&
          lastActiveSessionID &&
          !isExtractionSession(lastActiveSessionID)) {
        await runExtraction(lastActiveSessionID).catch(() => {})
      }
      disposed = true
      db.close()
      globalDb.close()
    },
  }
}) as Plugin
