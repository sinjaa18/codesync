import assert from "node:assert/strict"
import { createServer } from "node:http"
import express from "express"
import { test } from "node:test"
import { createReadinessHandler, healthHandler } from "../../src/observability/health.js"
import { errorHandler, httpRequestLogger, notFoundHandler, requestContext } from "../../src/observability/http.js"
import { logInfo } from "../../src/observability/logger.js"

async function makeServer(app: express.Express) {
  const server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function captureLogs<T>(run: (lines: string[]) => Promise<T>) {
  const lines: string[] = []
  const previousInfo = console.info
  const previousWarn = console.warn
  const previousError = console.error
  console.info = (...args) => { lines.push(args.join(" ")) }
  console.warn = (...args) => { lines.push(args.join(" ")) }
  console.error = (...args) => { lines.push(args.join(" ")) }
  try {
    return await run(lines)
  } finally {
    console.info = previousInfo
    console.warn = previousWarn
    console.error = previousError
  }
}

test("HTTP request IDs are safe, returned, and included in redacted structured logs", async () => {
  await captureLogs(async (lines) => {
    const app = express()
    app.use(requestContext, httpRequestLogger, express.json())
    app.get("/logged", (_req, res) => res.json({ ok: true }))
    app.post("/logged", (_req, res) => res.json({ ok: true }))
    app.get("/expected-client-error", (_req, res) => res.status(401).json({ error: "Authentication required." }))
    app.get("/database-error", (_req, _res, next) => next(Object.assign(new Error("postgresql://postgres:local-secret@localhost/codesync"), { code: "P1001" })))
    app.use(notFoundHandler, errorHandler)
    const server = await makeServer(app)
    try {
      const generated = await fetch(`${server.url}/logged?token=query-secret`, { headers: { Authorization: "Bearer header-secret", "X-Request-ID": "not a valid request id" } })
      const generatedId = generated.headers.get("x-request-id")
      assert.match(generatedId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

      const suppliedId = "4f8c5d8a-4c49-4f86-9478-ccf68e71f112"
      const supplied = await fetch(`${server.url}/logged`, { headers: { "X-Request-ID": suppliedId } })
      assert.equal(supplied.headers.get("x-request-id"), suppliedId)

      const body = JSON.stringify({ code: "private-source", password: "body-secret" })
      await fetch(`${server.url}/logged?key=query-secret`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer header-secret" }, body })
      const expected = await fetch(`${server.url}/expected-client-error`)
      assert.equal(expected.status, 401)
      assert.match(expected.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i)

      const failed = await fetch(`${server.url}/database-error`)
      assert.equal(failed.status, 500)
      const failedBody = await failed.json() as { error: string; requestId: string }
      assert.equal(failedBody.error, "Internal server error.")
      assert.match(failedBody.requestId, /^[0-9a-f-]{36}$/i)
      assert.doesNotMatch(JSON.stringify(failedBody), /local-secret|postgresql|P1001|stack/i)

      logInfo("observability.redaction_probe", {
        requestId: "safe-id",
        token: "unit-token-secret",
        password: "unit-password-secret",
        authorization: "Bearer unit-header-secret",
        sourceCode: "unit-source-secret",
        requestBody: "unit-body-secret",
        databaseUrl: "postgresql://unit-database-secret",
      })

      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.ok(parsed.some((line) => line.event === "http.request" && line.requestId === generatedId && line.path === "/logged"))
      assert.ok(parsed.some((line) => line.event === "database.request_failed" && line.errorCode === "P1001"))
      assert.ok(parsed.some((line) => line.event === "http.request" && line.status === 401))
      assert.ok(!parsed.some((line) => line.event === "http.unhandled_error" && line.status === 401))
      assert.ok(parsed.every((line) => typeof line.timestamp === "string" && ["info", "warn", "error"].includes(String(line.level))))
      const captured = lines.join("\n")
      for (const secret of ["query-secret", "header-secret", "body-secret", "private-source", "local-secret", "unit-token-secret", "unit-password-secret", "unit-header-secret", "unit-source-secret", "unit-body-secret", "unit-database-secret"]) {
        assert.ok(!captured.includes(secret), `logs must not include ${secret}`)
      }
    } finally {
      await server.close()
    }
  })
})

test("health is live and readiness reports database failures without exposing details", async () => {
  await captureLogs(async (lines) => {
    const app = express()
    app.use(requestContext, httpRequestLogger)
    app.get("/health", healthHandler)
    app.get("/ready", createReadinessHandler(async () => 1))
    app.get("/broken-ready", createReadinessHandler(async () => { throw new Error("database password is hidden-secret") }))
    const server = await makeServer(app)
    try {
      const health = await fetch(`${server.url}/health`)
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { status: "ok" })
      assert.ok(health.headers.get("x-request-id"))

      const ready = await fetch(`${server.url}/ready`)
      assert.equal(ready.status, 200)
      assert.deepEqual(await ready.json(), { status: "ready" })

      const broken = await fetch(`${server.url}/broken-ready`)
      assert.equal(broken.status, 503)
      const response = await broken.json() as { status: string; requestId: string }
      assert.deepEqual(response, { status: "not_ready", requestId: broken.headers.get("x-request-id") })
      assert.doesNotMatch(JSON.stringify(response), /hidden-secret|database password/)
      assert.ok(lines.some((line) => line.includes('"event":"database.not_ready"')))
      assert.ok(!lines.some((line) => line.includes("hidden-secret")))
    } finally {
      await server.close()
    }
  })
})
