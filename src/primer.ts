// Primer + index generation for the memory plugin

import type { Memory, TopicIndexEntry } from "./schema.ts"
import { estimateTokens } from "./utils.ts"

/** Format relative time from a timestamp. */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const hours = diff / 3600000
  const days = hours / 24

  if (hours < 1) return "just now"
  if (hours < 24) return `${Math.floor(hours)}h ago`
  if (days < 7) return `${Math.floor(days)}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

/**
 * Generate the memory primer: recent work, active topics, patterns, unfinished.
 * Bounded by the token budget (portion of contextBudget allocated to primer).
 */
export function generatePrimer(memories: Memory[], budgetTokens: number): string | undefined {
  if (memories.length === 0) return undefined

  const sections: string[] = ["## Memory"]

  // Recent Work — top memories by importance
  const recent = memories
    .filter((m) => m.type !== "prospective")
    .slice(0, 8)

  if (recent.length > 0) {
    const lines = recent.map((m) => `- [${relativeTime(m.created_at)}] ${m.title}`)
    sections.push("### Recent Work\n" + lines.join("\n"))
  }

  // Active Topics — group by topic, show counts
  const topicMap = new Map<string, Memory[]>()
  for (const m of memories) {
    const topic = m.topic ?? "general"
    if (!topicMap.has(topic)) topicMap.set(topic, [])
    topicMap.get(topic)!.push(m)
  }

  const topics = [...topicMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)

  if (topics.length > 0) {
    const lines = topics.map(([topic, mems]) => {
      const hasUnfinished = mems.some((m) => m.type === "prospective")
      const suffix = hasUnfinished ? " (unfinished)" : ""
      return `- ${topic} (${mems.length} memories${suffix})`
    })
    sections.push("### Active Topics\n" + lines.join("\n"))
  }

  // Patterns — semantic memories with category "pattern"
  const patterns = memories.filter((m) => m.type === "semantic" && m.category === "pattern")
  if (patterns.length > 0) {
    const lines = patterns.slice(0, 5).map((m) => `- ${m.title}`)
    sections.push("### Patterns\n" + lines.join("\n"))
  }

  // Unfinished — prospective memories
  const unfinished = memories.filter((m) => m.type === "prospective")
  if (unfinished.length > 0) {
    const lines = unfinished.slice(0, 5).map((m) => `- [ ] ${m.title}`)
    sections.push("### Unfinished\n" + lines.join("\n"))
  }

  let result = sections.join("\n\n")

  // Trim if over budget
  const budgetChars = budgetTokens * 4
  if (result.length > budgetChars) {
    // Progressive trimming: drop patterns first, then reduce recent items
    if (patterns.length > 0) {
      const idx = sections.findIndex((s) => s.startsWith("### Patterns"))
      if (idx >= 0) sections.splice(idx, 1)
      result = sections.join("\n\n")
    }
    if (result.length > budgetChars) {
      result = result.slice(0, budgetChars) + "..."
    }
  }

  return result || undefined
}

/**
 * Generate the compact memory index: one line per topic with count and categories.
 * This is a pointer system — tells the agent what memories exist so it can search.
 */
export function generateIndex(topics: TopicIndexEntry[]): string | undefined {
  if (topics.length === 0) return undefined

  const lines = topics.map((t) => {
    const cats = t.categories.length > 0 ? ` (${t.categories.join(", ")})` : ""
    return `- ${t.topic}: ${t.count} memories${cats}`
  })

  return "## Memory Index (call memory_search for details)\n" + lines.join("\n")
}
