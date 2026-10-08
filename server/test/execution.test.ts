import assert from "node:assert/strict"
import { test } from "node:test"
import { executeCode, ExecutionFailure } from "../src/execution/runner.js"

const input = { code: "print('hello')", language: "python" as const, stdin: "" }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

test("execution submits only server-owned resource limits and normalizes Judge0 output", async () => {
  let submission: Record<string, unknown> | undefined
  let calls = 0
  const result = await executeCode(input, {
    apiUrl: "http://judge0.test",
    authToken: "test-token",
    pollIntervalMs: 0,
    fetcher: async (url, init) => {
      calls += 1
      assert.equal(new Headers(init?.headers).get("X-Auth-Token"), "test-token")
      if (String(url).includes("/submissions?")) {
        submission = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json({ token: "submission-1" })
      }
      return json({ stdout: "hello\n", stderr: null, compile_output: null, time: "0.012", status: { id: 3, description: "Accepted" } })
    },
  })
  assert.equal(submission?.language_id, 71)
  assert.equal(submission?.enable_network, false)
  assert.equal(submission?.cpu_time_limit, 3)
  assert.equal(submission?.wall_time_limit, 5)
  assert.equal(submission?.memory_limit, 128_000)
  assert.equal(result.status, "accepted")
  assert.equal(result.stdout, "hello\n")
  assert.equal(result.executionTimeMs, 12)
  assert.equal(result.success, true)
  assert.equal(calls, 2)
})

test("execution deadline bounds a hanging poll request", async () => {
  const started = performance.now()
  let calls = 0
  await assert.rejects(executeCode(input, {
    apiUrl: "http://judge0.test",
    timeoutMs: 150,
    pollIntervalMs: 0,
    fetcher: async (_url, init) => {
      calls += 1
      if (calls === 1) return json({ token: "submission-1" })
      return new Promise<Response>((_resolve, reject) => {
        const keepEventLoopAlive = setTimeout(() => reject(new Error("deadline did not abort the request")), 400)
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepEventLoopAlive)
          reject(new DOMException("Aborted", "TimeoutError"))
        }, { once: true })
      })
    },
  }), (error: unknown) => error instanceof ExecutionFailure && error.status === "timeout")
  assert.ok(performance.now() - started < 500, "poll must abort within the single request deadline")
})

test("execution maps compilation, runtime, and sandbox timeout results", async () => {
  for (const [id, status] of [[5, "timeout"], [6, "compilation_error"], [11, "runtime_error"]] as const) {
    let calls = 0
    const result = await executeCode(input, {
      apiUrl: "http://judge0.test",
      pollIntervalMs: 0,
      fetcher: async () => {
        calls += 1
        return calls === 1 ? json({ token: "submission-1" }) : json({ stdout: null, stderr: "details", compile_output: "compiler", time: null, status: { id, description: "result" } })
      },
    })
    assert.equal(result.status, status)
    assert.equal(result.success, false)
    assert.equal(result.executionTimeMs, null)
  }
})

test("execution rejects malformed and oversized service responses", async () => {
  await assert.rejects(executeCode(input, {
    apiUrl: "http://judge0.test",
    fetcher: async () => new Response("not json"),
  }), (error: unknown) => error instanceof ExecutionFailure && error.status === "service_error")
  await assert.rejects(executeCode(input, {
    apiUrl: "http://judge0.test",
    fetcher: async () => new Response("x".repeat(128 * 1024 + 1)),
  }), (error: unknown) => error instanceof ExecutionFailure && error.status === "service_error")
})
