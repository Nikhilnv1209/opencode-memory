// Database init, queries, and FTS for the memory plugin

import { Database } from "bun:sqlite"
import { SCHEMA } from "./schema.ts"
import type { Memory, TopicIndexEntry } from "./schema.ts"

/** Initialize a project memory database. */
export function initDb(dbPath: string): Database {
  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA)
  // One-time cleanup: remove junk from recursive-loop bug + exact duplicates
  db.exec("DELETE FROM memory WHERE importance < 0.1")
  db.exec(`
    DELETE FROM memory
    WHERE rowid IN (
      SELECT m1.rowid FROM memory m1
      WHERE EXISTS (
        SELECT 1 FROM memory m2
        WHERE m2.topic = m1.topic AND m2.title = m1.title
        AND (m2.importance > m1.importance OR (m2.importance = m1.importance AND m2.rowid < m1.rowid))
      )
    )
  `)
  return db
}

/** Check if a similar memory already exists (same topic + title fuzzy match). */
function findDuplicate(db: Database, mem: Memory): Memory | null {
  // Exact title match on same topic
  const exact = db
    .query(
      `SELECT * FROM memory
       WHERE topic = ? AND title = ? AND superseded_by IS NULL
       LIMIT 1`,
    )
    .get(...[mem.topic, mem.title]) as RawMemoryRow | null

  if (exact) return rowToMemory(exact)

  // Fuzzy: same topic + first 40 chars of title match (catches minor wording differences)
  const fuzzy = db
    .query(
      `SELECT * FROM memory
       WHERE topic = ? AND substr(title, 1, 40) = substr(?, 1, 40) AND superseded_by IS NULL
       LIMIT 1`,
    )
    .get(...[mem.topic, mem.title]) as RawMemoryRow | null

  if (fuzzy) return rowToMemory(fuzzy)

  return null
}

/**
 * Store a memory, or merge with an existing duplicate.
 * If a similar memory exists (same topic + similar title), the more complete
 * version wins and the other is marked superseded.
 */
export function storeMemory(db: Database, mem: Memory): void {
  const existing = findDuplicate(db, mem)

  if (existing) {
    // Keep whichever has higher importance or longer content
    const newIsBetter = mem.importance >= existing.importance && mem.content.length >= existing.content.length

    if (newIsBetter) {
      // New memory replaces old — mark old as superseded, store new
      db.run(`UPDATE memory SET superseded_by = ? WHERE id = ?`, [mem.id, existing.id])
      insertMemory(db, mem)
    } else {
      // Existing is better — skip the new one, leave existing as-is
      return
    }
  } else {
    insertMemory(db, mem)
  }
}

function insertMemory(db: Database, mem: Memory): void {
  db.run(
    `INSERT INTO memory (id, session_id, project_id, scope, type, category, topic, title, content, keywords, importance, created_at, last_accessed, access_count, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  )
}

/** Search memories using FTS5. Returns matching memories with importance boosting. */
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

  // FTS5 search on title + content + keywords
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

/** Get recent memories with proper recency decay calculation. */
export function getRecentMemoriesDecayed(db: Database, projectId: string, limit: number): Memory[] {
  const now = Date.now()
  const rows = db
    .query(
      `SELECT *, importance * (1.0 / (1 + (? - created_at) / 86400000.0 * 0.1)) * (1.0 + access_count * 0.1) as score
       FROM memory
       WHERE project_id = ? AND superseded_by IS NULL
       ORDER BY score DESC
       LIMIT ?`,
    )
    .all(...[now, projectId, limit]) as (RawMemoryRow & { score: number })[]
  return rows.map(({ score, ...row }) => rowToMemory(row))
}

/** Get topic index: topic -> count + categories. */
export function getTopicIndex(db: Database, projectId: string): TopicIndexEntry[] {
  const rows = db
    .query(
      `SELECT topic, COUNT(*) as count, GROUP_CONCAT(DISTINCT category) as categories
       FROM memory
       WHERE project_id = ? AND superseded_by IS NULL
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

/** Get unfinished (prospective) memories. */
export function getUnfinishedMemories(db: Database, projectId: string): Memory[] {
  const rows = db
    .query(
      `SELECT * FROM memory
       WHERE project_id = ? AND type = 'prospective' AND superseded_by IS NULL
       ORDER BY importance DESC, created_at DESC`,
    )
    .all(...[projectId]) as RawMemoryRow[]
  return rows.map(rowToMemory)
}

/** Get memories by topic. */
export function getMemoriesByTopic(db: Database, projectId: string, topic: string): Memory[] {
  const rows = db
    .query(
      `SELECT * FROM memory
       WHERE project_id = ? AND topic = ? AND superseded_by IS NULL
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

/** Count total memories for a project. */
export function countMemories(db: Database, projectId: string): number {
  const row = db
    .query(`SELECT COUNT(*) as count FROM memory WHERE project_id = ?`)
    .get(...[projectId]) as { count: number }
  return row.count
}

/** Count memories for a specific session (used for backfill dedup). */
export function countMemoriesBySession(db: Database, sessionID: string): number {
  const row = db
    .query(`SELECT COUNT(*) as count FROM memory WHERE session_id = ?`)
    .get(...[sessionID]) as { count: number }
  return row.count
}

/** Prune lowest-importance memories when limit is exceeded. */
export function pruneMemories(db: Database, projectId: string, maxMemories: number): number {
  const count = countMemories(db, projectId)
  if (count <= maxMemories) return 0

  const excess = count - maxMemories
  db.run(
    `DELETE FROM memory WHERE id IN (
      SELECT id FROM memory WHERE project_id = ?
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
  }
}
