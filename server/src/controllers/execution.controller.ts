import type { Request, Response } from "express"
import type { CodeExecutionRequest } from "../validators/execution.validator.js"
import type { CodeExecutionResponse } from "../types/execution.types.js"

const languageIds: Record<CodeExecutionRequest["language"], number> = {
  javascript: 63,
  typescript: 74,
  python: 71,
  cpp: 54,
  java: 62,
}

type Judge0Result = {
  token?: string
  stdout?: string | null
  stderr?: string | null
  compile_output?: string | null
  message?: string | null
  time?: string | null
  status?: { id: number; description: string }
}

const apiUrl = (process.env.JUDGE0_API_URL || "https://ce.judge0.com").replace(/\/$/, "")
const authToken = process.env.JUDGE0_AUTH_TOKEN

async function judge0Fetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("Content-Type", "application/json")
  if (authToken) headers.set("X-Auth-Token", authToken)
  return fetch(`${apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(12_000) })
}

export const runCode = async (
  req: Request<Record<string, never>, CodeExecutionResponse | { error: string }, CodeExecutionRequest>,
  res: Response<CodeExecutionResponse | { error: string }>,
) => {
  const { code, language, stdin } = req.body
  const start = Date.now()
  try {
    const created = await judge0Fetch("/submissions?base64_encoded=false&wait=false", {
      method: "POST",
      body: JSON.stringify({
        source_code: code,
        language_id: languageIds[language],
        stdin,
        cpu_time_limit: 3,
        wall_time_limit: 5,
        memory_limit: 128_000,
        max_processes_and_or_threads: 20,
        max_file_size: 1_024,
        enable_network: false,
        enable_per_process_and_thread_time_limit: true,
      }),
    })
    if (!created.ok) {
      return res.status(created.status === 503 ? 503 : 502).json({ error: `Execution service returned HTTP ${created.status}.` })
    }
    const submission = await created.json() as Judge0Result
    if (!submission.token) return res.status(502).json({ error: "Execution service returned an invalid response." })

    let result = submission
    const deadline = Date.now() + 10_000
    while (!result.status || result.status.id <= 2) {
      if (Date.now() >= deadline) return res.status(504).json({ error: "Execution timed out while waiting for the sandbox." })
      await new Promise((resolve) => setTimeout(resolve, 400))
      const polled = await judge0Fetch(`/submissions/${encodeURIComponent(submission.token!)}?base64_encoded=false&fields=stdout,stderr,compile_output,message,time,status`)
      if (!polled.ok) return res.status(502).json({ error: `Execution service returned HTTP ${polled.status}.` })
      result = await polled.json() as Judge0Result
    }

    const output = result.stdout ?? ""
    const error = result.stderr ?? result.compile_output ?? result.message ?? (result.status.id !== 3 ? result.status.description : "")
    res.json({
      stdout: output,
      stderr: error,
      executionTimeMs: result.time ? Math.round(Number(result.time) * 1000) : Date.now() - start,
      success: result.status.id === 3,
    })
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Execution service did not respond in time."
      : "Execution service is unavailable. Check the server connection and Judge0 configuration."
    res.status(502).json({ error: message })
  }
}
