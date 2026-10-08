import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error("Test database is not configured. Set DATABASE_URL to a dedicated local PostgreSQL database named codesync_test; see README.md → Testing.")
  process.exit(1)
}

let parsed
try {
  parsed = new URL(databaseUrl)
} catch {
  console.error("DATABASE_URL is not a valid PostgreSQL URL. Use postgresql://USER:PASSWORD@localhost:5432/codesync_test?schema=public.")
  process.exit(1)
}

const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] ?? "")
if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
  console.error("The test database must use PostgreSQL.")
  process.exit(1)
}
if (!databaseName || databaseName !== "codesync_test") {
  console.error(`Refusing to reset database "${databaseName || "(missing)"}". Test reset is restricted to a database named codesync_test.`)
  process.exit(1)
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
  console.error(`Refusing to reset non-local database host "${parsed.hostname}". Use a dedicated local PostgreSQL test database.`)
  process.exit(1)
}

const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const prismaCli = path.join(serverDirectory, "node_modules", "prisma", "build", "index.js")
try {
  execFileSync(process.execPath, [prismaCli, "migrate", "reset", "--force", "--skip-seed"], {
    cwd: serverDirectory,
    env: process.env,
    stdio: "inherit",
  })
} catch {
  console.error("Could not reset the dedicated test database. Confirm PostgreSQL is running, codesync_test exists, and DATABASE_URL credentials can connect to it.")
  process.exit(1)
}
