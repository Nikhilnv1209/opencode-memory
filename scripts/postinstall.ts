import { existsSync, mkdirSync, copyFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const configDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "opencode",
)
const agentDir = join(configDir, "agent")
const agentFile = join(agentDir, "memory-extraction.md")
const sourceFile = join(import.meta.dir, "..", "agent", "memory-extraction.md")

if (!existsSync(sourceFile)) {
  console.error("[opencode-memory] Agent source file not found:", sourceFile)
  process.exit(0)
}

if (existsSync(agentFile)) {
  // Already installed — overwrite to keep in sync with plugin version
  copyFileSync(sourceFile, agentFile)
  process.exit(0)
}

mkdirSync(agentDir, { recursive: true })
copyFileSync(sourceFile, agentFile)
console.log("[opencode-memory] Installed extraction agent to", agentFile)
