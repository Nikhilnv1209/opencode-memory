# opencode-memory

> Persistent cross-session memory for [opencode](https://opencode.ai) agents. Extracts durable knowledge from conversations, stores it in SQLite with full-text search, and injects a compact primer at session start.

<p>
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="opencode" src="https://img.shields.io/badge/opencode-%3E%3D1.17.0-purple">
  <img alt="Status" src="https://img.shields.io/badge/status-beta-orange">
</p>

---

## Why

Every AI session starts from scratch. The agent has no memory of what you worked on yesterday, what bugs you fixed and why, what decisions you made, or how you like to work. Each conversation is an amnesiac interaction — intelligent in the moment, but incapable of learning over time.

This is the gap between **intelligence** and **memory**. Current AI systems are highly intelligent — they can reason, generate, and solve complex problems within a single conversation. But intelligence without memory is a goldfish: brilliant in the moment, forgetting everything by the next session.

> True AGI isn't just about reasoning better — it's about *learning* from experience, the way humans do.

### How humans remember

Human memory isn't a flat log of events. It's structured into distinct types:

| Type | What it is | Example |
|------|-----------|---------|
| **Episodic** | Specific experiences | "Fixed the auth bug last Tuesday by correcting the JWT expiry comparison" |
| **Semantic** | Distilled knowledge | "The auth module uses JWT with 1-hour expiry" |
| **Procedural** | How-to knowledge | "To build, run `bun run script/build.ts --single`" |
| **Prospective** | Things to do | "Need to test the ~ expansion in add-dir" |

We don't remember every word of every conversation. We remember what **mattered** — the intent, the root cause, the decision and its reasoning. Over time, episodic memories consolidate into semantic knowledge.

### How current AI memory fails

Existing memory systems capture surface-level observations:

| What they store | What they miss |
|----------------|---------------|
| "edited auth.ts" | *Why* — fixing token refresh because of off-by-one at line 42 |
| "ran build command" | *What was decided* — switched from webpack to bun for cold start |
| "user said hello" | *How the user communicates* — prefers terse, direct responses |

They store **what happened**, not **what was learned**. They treat memory as a log file, not as knowledge.

### What this plugin does differently

| Feature | Description |
|---------|-------------|
| **Meaningful extraction** | Captures intent, root cause, decisions, and reasoning — not just actions |
| **Human memory types** | Episodic, semantic, procedural, prospective |
| **Conversation classification** | Distinguishes IMPLEMENTATION from RESEARCH from META-CONVERSATION |
| **Cross-session patterns** | Recurring issues become semantic knowledge (planned) |
| **Personality profile** | Learns how the user communicates and works over time (planned) |
| **Soft delete** | Deleted memories stay deleted — prevents re-extraction of wrong info |
| **Extraction signals** | Manually-added memories guide future extraction style |
| **Bounded injection** | Curated primer at session start, not a dump of everything |

---

## What sets this apart

Most AI memory plugins are transactional logs — they record what happened and replay it. This plugin treats memory the way humans do: structured, meaningful, and evolving.

### vs. existing memory systems

| Capability | Typical memory plugins | opencode-memory |
|-----------|----------------------|-----------------|
| Memory types | Flat event log | Episodic, semantic, procedural, prospective |
| Content depth | "edited auth.ts" | Intent, root cause, evidence, reasoning, outcome |
| Conversation awareness | Treats all conversations equally | Classifies IMPLEMENTATION vs RESEARCH vs META-CONVERSATION |
| Status reports | Extracts described work as current work | Recognizes user is *describing* work, not *doing* it |
| Deduplication | Title matching only | Jaccard content similarity (keyword-independent) |
| Delete behavior | Hard delete, can be re-extracted | Soft delete, blocks re-extraction permanently |
| Manual memories | Not supported | Add/update/delete with extraction signal feedback |
| Learning from user | None | Manual memories guide future extraction style |
| Consolidation | None | Cross-session pattern detection → semantic memories (planned) |

### The personality system (planned)

This is the feature no other memory plugin has. Beyond remembering *what* happened in a project, the system builds a **personality profile** of the user — how they communicate, what they value, their working style, their preferences for detail level and report format.

**Three modes:**

| Mode | How it works |
|------|-------------|
| **Preset** | User picks a starting personality (e.g., "Senior Engineer", "Thorough Researcher"). System learns in background. |
| **Learning** | System observes personality traits across sessions and projects. Traits confirmed 2+ times are promoted. |
| **Override** | System has enough data to suggest a personalized personality. User accepts or rejects. |

The personality is stored in `~/.opencode/personality.md` — human-readable, user-editable, injected into every session across all projects. It captures things like:

- Communication style (terse vs verbose, bullet points vs prose)
- Detail level preferences (wants 20+ bullet points in status reports)
- Working patterns (verifies before building, asks "why" before accepting)
- Technical preferences (functional style, Bun over Node, ternaries over if/else)
- Recurring cross-project patterns (tends to find root causes, gets frustrated with workarounds)

No existing memory system builds this. They remember what you did. This remembers **who you are**.

---

## Installation

### Local path

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    ["/path/to/opencode-memory", {
      "models": {
        "extraction": "umans/umans-glm-5.1"
      },
      "maxConcurrentExtractions": 1
    }]
  ]
}
```

The postinstall script copies the extraction agent to `~/.config/opencode/agent/memory-extraction.md`. **Restart opencode** after installation.

### GitHub (future)

```bash
opencode plugin install user/opencode-memory
```

---

## How it works

### Architecture

```
~/.opencode/
  memory/
    global.db                                # Extraction session tracking
    projects/
      <sha256-hash-of-worktree>/
        memory.db                            # Project memories + FTS5 index
  personality.md                             # User personality (future)
```

### Extraction flow

```
Conversation ends (compaction / session switch / exit)
  │
  ├─ Format conversation (user msgs + assistant text + action tool calls)
  ├─ Query manual memories for <signals> (style guidance)
  ├─ Create temp session with agent="memory-extraction"
  │   ├─ All tools disabled (agent config)
  │   ├─ XML-structured system prompt (sole prompt the model sees)
  │   └─ User message: instruction + signals + conversation
  ├─ Model outputs: CLASSIFICATION line + JSON memory lines
  ├─ Parse JSON (handles markdown code blocks)
  ├─ Dedup against ALL memories (including deleted) via Jaccard similarity
  └─ Store in project memory.db
```

### Decision tree (in extraction prompt)

```
Q1: Did the user edit files in THIS session?
    ├─ YES → IMPLEMENTATION (importance: 0.7-0.9)
    └─ NO → Q2

Q2: Is the user DESCRIBING work done elsewhere?
    ├─ YES → META-CONVERSATION (personality only, 0.4-0.6)
    └─ NO → Q3

Q3: Is the user asking questions or exploring ideas?
    ├─ YES → RESEARCH (importance: 0.3-0.5)
    └─ NO → DECISION or PREFERENCE
```

### Injection at session start

```
System prompt (within contextBudget, default 800 tokens)
  ├─ Personality (if present)        ~200-400 tokens
  ├─ Primer (recent work, topics)    ~200-300 tokens
  └─ Memory index (pointer list)      ~100 tokens
```

### Triggers

| Trigger | Config | Default | When |
|---------|--------|---------|------|
| Compaction | `compaction` | on | Before context is compacted |
| Session switch | `session-switch` | on | User switches sessions or exits opencode |
| Manual backfill | — | — | Via `memory_backfill` tool |

### Deduplication

| Check | Method | Scope |
|-------|--------|-------|
| Exact title | Same topic + same title | All memories (incl. deleted) |
| Fuzzy title | Same topic + 40-char prefix match | All memories (incl. deleted) |
| Content similarity | Jaccard word overlap > 40% | Same-topic memories (incl. deleted) |

Deleted memories block re-extraction. Manual memories can't be superseded by extracted ones.

---

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | FTS5 keyword search with importance boosting |
| `memory_list` | List all memories sorted by importance (includes IDs for update/delete) |
| `memory_add` | Manually create a memory — stored as `source: "manual"` |
| `memory_update` | Edit title, content, importance, or keywords by ID |
| `memory_delete` | Soft-delete by ID — won't appear in results, blocks re-extraction |
| `memory_backfill` | Backfill from previous sessions (synchronous — blocks until done) |

---

## Configuration

```json
{
  "plugin": [
    ["/path/to/opencode-memory", {
      "models": {
        "extraction": "umans/umans-glm-5.1"
      },
      "triggers": ["compaction", "session-switch"],
      "maxConcurrentExtractions": 1,
      "contextBudget": 800,
      "maxMemories": 500
    }]
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `models.extraction` | user's default | Model for extraction (any provider/model in opencode) |
| `triggers` | `["compaction", "session-switch"]` | Which events trigger extraction |
| `maxConcurrentExtractions` | `1` | Max parallel extractions (1 = sequential) |
| `contextBudget` | `800` | Max tokens injected into system prompt |
| `maxMemories` | `500` | Max memories per project before pruning |

---

## Roadmap

### Done

- [x] SQLite schema with FTS5 full-text search
- [x] Custom extraction agent (`memory-extraction.md`) with XML-structured prompt
- [x] Conversation classification decision tree (IMPLEMENTATION / RESEARCH / META-CONVERSATION / DECISION / PREFERENCE)
- [x] Triggers: compaction + session-switch detection (via `system.transform` hook)
- [x] Conversation formatting (tool outputs excluded, action tools only)
- [x] Chunking for large conversations (60K token limit)
- [x] Synchronous backfill with progress tracking
- [x] `memory_search` — FTS5 search with importance boosting
- [x] `memory_list` — list all memories (includes IDs)
- [x] `memory_add` — manual memory creation
- [x] `memory_update` — edit by ID
- [x] `memory_delete` — soft delete (prevents re-extraction)
- [x] Jaccard content similarity dedup (>40% overlap)
- [x] Deleted memories block re-extraction
- [x] Manual memories can't be superseded by extracted ones
- [x] Extraction signals from manual memories (style guidance)
- [x] Importance decay + access boosting
- [x] Memory pruning when `maxMemories` exceeded
- [x] Primer + memory index injection at session start
- [x] Postinstall script for agent installation

### In Progress

- [ ] Prompt tuning for richer memory content

### Planned

- [ ] **Contextual injection** — proactively match memories to conversation context (file paths, keywords)
- [ ] **Personality system** — preset selection, background learning, trait adoption, user-controlled override
- [ ] **Consolidation** — cross-session pattern detection, episodic → semantic promotion
- [ ] **Cross-project personality** — promote universal preferences from multiple projects
- [ ] **README polish** — installation GIF, examples, FAQ
- [ ] **Publish** — GitHub repo, `opencode plugin install` support

---

## License

Apache-2.0
