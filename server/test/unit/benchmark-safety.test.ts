import assert from "node:assert/strict"
import { test } from "node:test"
import { assertSafeBenchmarkTarget, parseBenchmarkOptions } from "../../src/benchmark/safety.js"

test("benchmark is explicitly opted in and restricted to loopback codesync_test", () => {
  const safeUrl = "postgresql://postgres:secret@localhost:5432/codesync_test?schema=public"
  assert.throws(() => assertSafeBenchmarkTarget(safeUrl, false), /Pass --allow-local-target/)
  assert.doesNotThrow(() => assertSafeBenchmarkTarget(safeUrl, true))
  assert.doesNotThrow(() => assertSafeBenchmarkTarget("postgres://user:secret@[::1]:5432/codesync_test", true))
  assert.throws(() => assertSafeBenchmarkTarget(undefined, true), /DATABASE_URL is required/)
  assert.throws(() => assertSafeBenchmarkTarget("postgresql://user:secret@db.example/codesync_test", true), /Refusing benchmark target/)
  assert.throws(() => assertSafeBenchmarkTarget("postgresql://user:secret@localhost/codesync_dev", true), /Refusing benchmark target/)
  assert.throws(() => assertSafeBenchmarkTarget("postgresql://user:secret@localhost/codesync_bench", true), /Refusing benchmark target/)
})

test("benchmark load limits are conservative and reject invalid arguments", () => {
  assert.deepEqual(parseBenchmarkOptions(["--allow-local-target"]), {
    allowLocalTarget: true,
    maxClients: 10,
    requestsPerRepetition: 30,
    repetitions: 3,
  })
  assert.equal(parseBenchmarkOptions(["--max-clients", "25"]).maxClients, 25)
  assert.throws(() => parseBenchmarkOptions(["--max-clients", "26"]), /between 2 and 25/)
  assert.throws(() => parseBenchmarkOptions(["--requests", "1000"]), /between 10 and 100/)
  assert.throws(() => parseBenchmarkOptions(["--surprise"]), /Unknown benchmark option/)
})
