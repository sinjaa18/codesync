import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const resetScript = fileURLToPath(new URL("../../scripts/reset-test-db.mjs", import.meta.url))

test("test database reset refuses missing, non-test, and remote database targets", () => {
  const missing = spawnSync(process.execPath, [resetScript], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /Set DATABASE_URL to a dedicated local PostgreSQL database named codesync_test/)

  const otherDatabase = spawnSync(process.execPath, [resetScript], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://test@localhost:5432/codesync?schema=public" } })
  assert.notEqual(otherDatabase.status, 0)
  assert.match(otherDatabase.stderr, /Refusing to reset database "codesync"/)

  const remoteDatabase = spawnSync(process.execPath, [resetScript], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://test@db.example:5432/codesync_test?schema=public" } })
  assert.notEqual(remoteDatabase.status, 0)
  assert.match(remoteDatabase.stderr, /Refusing to reset non-local database host/)
})
