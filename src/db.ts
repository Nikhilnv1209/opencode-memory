// Database init, queries, and FTS for the memory plugin

import { Database } from "bun:sqlite"
import { SCHEMA, MIGRATION_ADD_SOURCE_DELETED } from "./schema.ts"
import type { Memory, TopicIndexEntry, MemorySource } from "./schema.ts"

/** Initialize a project memory database. */
export function initDb(dbPath: string): Database {
  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA)

  // Migration: add source and deleted columns if missing (existing databases)
  const columns = db.query("PRAGMA table_info(memory)").all() as { name: string }[]
  const hasSource = columns.some((c) => c.name === "source")
  const hasDeleted = columns.some((c) => c.name === "deleted")
  if (!hasSource) db.exec("ALTER TABLE memory ADD COLUMN source TEXT NOT NULL DEFAULT 'extraction'")
  if (!hasDeleted) db.exec("ALTER TABLE memory ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
  if (!hasDeleted) db.exec("CREATE INDEX IF NOT EXISTS idx_memory_deleted ON memory(deleted)")

  // One-time cleanup: remove junk from recursive-loop bug
  db.exec("DELETE FROM memory WHERE importance < 0.1 AND deleted = 0")
  return db
}

// --- Stopwords for Jaccard similarity ---
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "can", "shall", "to", "of", "in",
  "on", "at", "by", "for", "with", "about", "as", "into", "through",
  "during", "before", "after", "above", "below", "from", "up", "down",
  "and", "or", "but", "if", "then", "else", "when", "where", "why",
  "how", "all", "any", "both", "each", "few", "more", "most", "other",
  "some", "such", "no", "not", "only", "own", "same", "so", "than",
  "too", "very", "just", "this", "that", "these", "those", "i", "you",
  "he", "she", "it", "we", "they", "what", "which", "who", "whom",
  "user", "memory", "session", "work", "like", "also",
])

/** Normalize text into a Set of significant words for Jaccard comparison. */
function wordSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  )
}

/** Compute Jaccard similarity between two word sets. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const word of a) {
    if (b.has(word)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

/**
 * Check if a similar memory already exists.
 * Uses exact title match, fuzzy title prefix, AND Jaccard content similarity.
 * Compares against ALL memories (including deleted) to prevent re-extraction
 * of deleted memories.
 */
function findDuplicate(db: Database, mem: Memory): Memory | null {
  // Exact title match on same topic (including deleted — prevents re-adding deleted)
  const exact = db
    .query(
      `SELECT * FROM memory
       WHERE topic = ? AND title = ?
       LIMIT 1`,
    )
    .get(...[mem.topic, mem.title]) as RawMemoryRow | null
  if (exact) return rowToMemory(exact)

  // Fuzzy: same topic + first 40 chars of title match
  const fuzzy = db
    .query(
      `SELECT * FROM memory
       WHERE topic = ? AND substr(title, 1, 40) = substr(?, 1, 40)
       LIMIT 1`,
    )
    .get(...[mem.topic, mem.title]) as RawMemoryRow | null
  if (fuzzy) return rowToMemory(fuzzy)

  // Jaccard content similarity against same-topic memories (including deleted)
  const candidates = db
    .query(
      `SELECT * FROM memory WHERE topic = ? AND superseded_by IS NULL`,
    )
    .all(...[mem.topic]) as RawMemoryRow[]

  if (candidates.length === 0) return null

  const newWords = wordSet(mem.title + " " + mem.content)
  let bestMatch: Memory | null = null
  let bestScore = 0

  for (const row of candidates) {
    const existingWords = wordSet(row.title + " " + row.content)
    const score = jaccardSimilarity(newWords, existingWords)
    if (score > 0.4 && score > bestScore) {
      bestScore = score
      bestMatch = rowToMemory(row)
    }
  }

  return bestMatch
}

/**
 * Store a memory, or merge with an existing duplicate.
 * Compares against ALL memories (including deleted) to prevent re-extraction.
 * If a duplicate is found:
 * - If duplicate is deleted → skip (user already decided it's wrong)
 * - If duplicate is manual → skip (manual memories take priority)
 * - If new is richer/higher importance → supersede old
 * - Otherwise → skip
 */
export function storeMemory(db: Database, mem: Memory): void {
  const existing = findDuplicate(db, mem)

  if (existing) {
    // Don't re-add if the duplicate was deleted by the user
    if (existing.deleted) return

    // Don't supersede manually-added memories with extracted ones
    if (existing.source === "manual" && mem.source === "extraction") return

    const newIsBetter = mem.importance >= existing.importance && mem.content.length >= existing.content.length

    if (newIsBetter) {
      db.run(`UPDATE memory SET superseded_by = ? WHERE id = ?`, [mem.id, existing.id])
      insertMemory(db, mem)
    }
  } else {
    insertMemory(db, mem)
  }
}

/** Insert a memory row directly (no dedup check). */
function insertMemory(db: Database, mem: Memory): void {
  db.run(
    `INSERT INTO memory (id, session_id, project_id, scope, type, category, topic, title, content, keywords, importance, created_at, last_accessed, access_count, superseded_by, source, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      mem.id,
      mem.session_id,
      mem.project_id,
      mem.scope,
      mem.type,
      mem.category,
      mem.topic,
      mem.title,
      mem.content,
      JSON.stringify(mem.keywords),
      mem.importance,
      mem.created_at,
      mem.last_accessed,
      mem.access_count,
      mem.superseded_by,
      mem.source,
      mem.deleted,
    ],
  )
}

/** Search memories using FTS5. Excludes deleted and superseded. */
export function searchMemories(
  db: Database,
  opts: {
    query: string
    topic?: string
    scope?: string
    projectId: string
    limit?: number
  },
): Memory[] {
  const limit = opts.limit ?? 5

  const ftsQuery = opts.query
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replace(/"/g, '""')}"*`)
    .join(" ")

  if (!ftsQuery) return []

  let sql = `
    SELECT m.* FROM memory m
    JOIN memory_fts f ON m.rowid = f.rowid
    WHERE memory_fts MATCH ?
    AND m.deleted = 0 AND m.superseded_by IS NULL
  `
  const params: unknown[] = [ftsQuery]

  if (opts.topic) {
    sql += ` AND m.topic = ?`
    params.push(opts.topic)
  }
  if (opts.scope) {
    sql += ` AND m.scope = ?`
    params.push(opts.scope)
  }
  if (opts.projectId) {
    sql += ` AND m.project_id = ?`
    params.push(opts.projectId)
  }

  sql += ` ORDER BY m.importance DESC, m.created_at DESC LIMIT ?`
  params.push(limit)

  const rows = db.query(sql).all(...params) as RawMemoryRow[]
  return rows.map(rowToMemory)
}

/** Get recent memories with recency decay. Excludes deleted and superseded. */
export function getRecentMemoriesDecayed(db: Database, projectId: string, limit: number): Memory[] {
  const now = Date.now()
  const rows = db
    .query(
      `SELECT *, importance * (1.0 / (1 + (? - created_at) / 86400000.0 * 0.1)) * (1.0 + access_count * 0.1) as score
       FROM memory
       WHERE project_id = ? AND superseded_by IS NULL AND deleted = 0
       ORDER BY score DESC
       LIMIT ?`,
    )
    .all(...[now, projectId, limit]) as (RawMemoryRow & { score: number })[]
  return rows.map(({ score, ...row }) => rowToMemory(row))
}

/** Get manually-added memories (for extraction signals). Excludes deleted. */
export function getManualMemories(db: Database, projectId: string, limit: number): Memory[] {
  const rows = db
    .query(
      `SELECT * FROM memory
       WHERE project_id = ? AND source = 'manual' AND deleted = 0 AND superseded_by IS NULL
       ORDER BY importance DESC, created_at DESC
       LIMIT ?`,
    )
    .all(...[projectId, limit]) as RawMemoryRow[]
  return rows.map(rowToMemory)
}

/** Get topic index: topic -> count + categories. Excludes deleted. */
export function getTopicIndex(db: Database, projectId: string): TopicIndexEntry[] {
  const rows = db
    .query(
      `SELECT topic, COUNT(*) as count, GROUP_CONCAT(DISTINCT category) as categories
       FROM memory
       WHERE project_id = ? AND superseded_by IS NULL AND deleted = 0
       GROUP BY topic
       ORDER BY count DESC`,
    )
    .all(...[projectId]) as { topic: string; count: number; categories: string }[]

  return rows.map((r) => ({
    topic: r.topic,
    count: r.count,
    categories: r.categories?.split(",") ?? [],
  }))
}

/** Get unfinished (prospective) memories. Excludes deleted. */
export function getUnfinishedMemories(db: Database, projectId: string): Memory[] {
  const rows = db
    .query(
      `SELECT * FROM memory
       WHERE project_id = ? AND type = 'prospective' AND superseded_by IS NULL AND deleted = 0
       ORDER BY importance DESC, created_at DESC`,
    )
    .all(...[projectId]) as RawMemoryRow[]
  return rows.map(rowToMemory)
}

/** Get memories by topic. Excludes deleted. */
export function getMemoriesByTopic(db: Database, projectId: string, topic: string): Memory[] {
  const rows = db
    .query(
      `SELECT * FROM memory
       WHERE project_id = ? AND topic = ? AND superseded_by IS NULL AND deleted = 0
       ORDER BY created_at DESC`,
    )
    .all(...[projectId, topic]) as RawMemoryRow[]
  return rows.map(rowToMemory)
}

/** Boost importance of accessed memories. */
export function boostAccessed(db: Database, memoryIds: string[]): void {
  const now = Date.now()
  for (const id of memoryIds) {
    db.run(
      `UPDATE memory SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`,
      [now, id],
    )
  }
}

/** Count active (non-deleted) memories for a project. */
export function countMemories(db: Database, projectId: string): number {
  const row = db
    .query(`SELECT COUNT(*) as count FROM memory WHERE project_id = ? AND deleted = 0`)
    .get(...[projectId]) as { count: number }
  return row.count
}

/** Count memories for a specific session (used for backfill dedup). */
export function countMemoriesBySession(db: Database, sessionID: string): number {
  const row = db
    .query(`SELECT COUNT(*) as count FROM memory WHERE session_id = ? AND deleted = 0`)
    .get(...[sessionID]) as { count: number }
  return row.count
}

/** Soft-delete a memory by ID. */
export function deleteMemory(db: Database, id: string): boolean {
  const result = db.run(
    `UPDATE memory SET deleted = 1 WHERE id = ? AND deleted = 0`,
    [id],
  )
  return result.changes > 0
}

/** Update a memory's content, importance, and keywords by ID. */
export function updateMemory(
  db: Database,
  id: string,
  updates: { content?: string; importance?: number; keywords?: string[]; title?: string },
): Memory | null {
  const sets: string[] = []
  const params: unknown[] = []

  if (updates.title !== undefined) {
    sets.push("title = ?")
    params.push(updates.title)
  }
  if (updates.content !== undefined) {
    sets.push("content = ?")
    params.push(updates.content)
  }
  if (updates.importance !== undefined) {
    sets.push("importance = ?")
    params.push(updates.importance)
  }
  if (updates.keywords !== undefined) {
    sets.push("keywords = ?")
    params.push(JSON.stringify(updates.keywords))
  }

  if (sets.length === 0) return null

  params.push(id)
  db.run(`UPDATE memory SET ${sets.join(", ")} WHERE id = ? AND deleted = 0`, ...params)

  const row = db.query(`SELECT * FROM memory WHERE id = ?`).get(id) as RawMemoryRow | null
  return row ? rowToMemory(row) : null
}

/** Get a single memory by ID. */
export function getMemoryById(db: Database, id: string): Memory | null {
  const row = db.query(`SELECT * FROM memory WHERE id = ?`).get(id) as RawMemoryRow | null
  return row ? rowToMemory(row) : null
}

/** Prune lowest-importance memories when limit is exceeded. Only prunes active memories. */
export function pruneMemories(db: Database, projectId: string, maxMemories: number): number {
  const count = countMemories(db, projectId)
  if (count <= maxMemories) return 0

  const excess = count - maxMemories
  db.run(
    `DELETE FROM memory WHERE id IN (
      SELECT id FROM memory WHERE project_id = ? AND deleted = 0
      ORDER BY importance ASC, last_accessed ASC LIMIT ?
    )`,
    [projectId, excess],
  )
  return excess
}

// --- Internal helpers ---

type RawMemoryRow = {
  id: string
  session_id: string
  project_id: string
  scope: string
  type: string
  category: string
  topic: string | null
  title: string
  content: string
  keywords: string | null
  importance: number
  created_at: number
  last_accessed: number
  access_count: number
  superseded_by: string | null
  source: string
  deleted: number
}

function rowToMemory(row: RawMemoryRow): Memory {
  return {
    id: row.id,
    session_id: row.session_id,
    project_id: row.project_id,
    scope: row.scope as Memory["scope"],
    type: row.type as Memory["type"],
    category: row.category,
    topic: row.topic ?? "general",
    title: row.title,
    content: row.content,
    keywords: row.keywords ? JSON.parse(row.keywords) : [],
    importance: row.importance,
    created_at: row.created_at,
    last_accessed: row.last_accessed,
    access_count: row.access_count,
    superseded_by: row.superseded_by,
    source: (row.source ?? "extraction") as MemorySource,
    deleted: row.deleted ?? 0,
  }
}
