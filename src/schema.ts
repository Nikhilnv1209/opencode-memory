// SQLite schema + TypeScript types for the memory plugin

export type MemoryType = "episodic" | "semantic" | "procedural" | "prospective"
export type MemoryScope = "project" | "personality"
export type PersonalityMode = "preset" | "override" | "manual"

export interface Memory {
  id: string
  session_id: string
  project_id: string
  scope: MemoryScope
  type: MemoryType
  category: string
  topic: string
  title: string
  content: string
  keywords: string[]
  importance: number
  created_at: number
  last_accessed: number
  access_count: number
  superseded_by: string | null
}

export interface TopicIndexEntry {
  topic: string
  count: number
  categories: string[]
}

// Project memory database schema (one per project)
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  topic TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL DEFAULT 0,
  access_count INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_topic ON memory(topic);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title,
  content,
  keywords,
  content='memory',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, title, content, keywords)
  VALUES (new.rowid, new.title, new.content, new.keywords);
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, keywords)
  VALUES ('delete', old.rowid, old.title, old.content, old.keywords);
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, keywords)
  VALUES ('delete', old.rowid, old.title, old.content, old.keywords);
  INSERT INTO memory_fts(rowid, title, content, keywords)
  VALUES (new.rowid, new.title, new.content, new.keywords);
END;
`

// Global database schema (cross-project: personality candidates + state)
export const GLOBAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS personality_candidate (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT,
  category TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  promoted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_candidate_keywords ON personality_candidate(keywords);
CREATE INDEX IF NOT EXISTS idx_candidate_category ON personality_candidate(category);

CREATE TABLE IF NOT EXISTS personality_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
