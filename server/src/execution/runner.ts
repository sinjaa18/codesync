import { performance } from "node:perf_hooks"
import { z } from "zod"
import { languageIds, type SupportedLanguage } from "./languages.js"
import type { CodeExecutionResponse } from "../types/execution.types.js"

const responseLimitBytes = 128 * 1024
const outputLimitChars = 16_000
const judgeResultSchema = z.object({
  token: z.string().min(1).optional(),
  stdout: z.string().nullable().optional(),
  stderr: z.string().nullable().optional(),
  compile_output: z.string().nullable().optional(),
  time: z.string().nullable().optional(),
  status: z.object({ id: z.number().int(), description: z.string() }).optional(),
})

export class ExecutionFailure extends Error {
  constructor(readonly status: "timeout" | "service_error", message: string) {
    super(message)
  }
}

export type ExecutionInput = { code: string; language: SupportedLanguage; stdin: string }
export type RunnerOptions = {
  apiUrl?: string
  authToken?: string
  fetcher?: typeof fetch
  timeoutMs?: number
  pollIntervalMs?: number
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > responseLimitBytes) {
    await response.body?.cancel()
    throw new ExecutionFailure("service_error", "Execution service returned an invalid response.")
  }
  if (!response.body) throw new ExecutionFailure("service_error", "Execution service returned an invalid response.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > responseLimitBytes) {
        await reader.cancel()
        throw new ExecutionFailure("service_error", "Execution service returned an invalid response.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    throw new ExecutionFailure("service_error", "Execution service returned an invalid response.")
  }
}

function normalizedOutput(value: string | null | undefined): { value: string; truncated: boolean } {
  const output = value ?? ""
  return output.length > outputLimitChars
    ? { value: output.slice(0, outputLimitChars), truncated: true }
    : { value: output, truncated: false }
}

export async function executeCode(input: ExecutionInput, options: RunnerOptions = {}): Promise<CodeExecutionResponse> {
  const started = performance.now()
  const deadline = started + (options.timeoutMs ?? 10_000)
  const apiUrl = (options.apiUrl ?? process.env.JUDGE0_API_URL ?? "https://ce.judge0.com").replace(/\/$/, "")
  const fetcher = options.fetcher ?? fetch

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new ExecutionFailure("timeout", "Execution service did not respond in time.")
    const headers = new Headers(init?.headers)
    headers.set("Content-Type", "application/json")
    const authToken = options.authToken ?? process.env.JUDGE0_AUTH_TOKEN
    if (authToken) headers.set("X-Auth-Token", authToken)
    try {
      return await fetcher(`${apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))) })
    } catch (error) {
      if (performance.now() >= deadline || (error instanceof Error && error.name === "TimeoutError")) {
        throw new ExecutionFailure("timeout", "Execution service did not respond in time.")
      }
      throw new ExecutionFailure("service_error", "Execution service is unavailable. Check the server connection and Judge0 configuration.")
    }
  }

  const readResult = async (response: Response, includeToken: boolean) => {
    if (!response.ok) {
      throw new ExecutionFailure("service_error", response.status === 503
        ? "Execution service is temporarily unavailable."
        : "Execution service returned an error.")
    }
    let body: unknown
    try {
      body = await boundedJson(response)
    } catch (error) {
      if (performance.now() >= deadline || (error instanceof Error && error.name === "TimeoutError")) {
        throw new ExecutionFailure("timeout", "Execution service did not respond in time.")
      }
      throw error
    }
    const parsed = judgeResultSchema.safeParse(body)
    if (!parsed.success || (includeToken && !parsed.data.token) || (!includeToken && !parsed.data.status)) {
      throw new ExecutionFailure("service_error", "Execution service returned an invalid response.")
    }
    return parsed.data
  }

  const submission = await readResult(await request("/submissions?base64_encoded=false&wait=false", {
    method: "POST",
    body: JSON.stringify({
      source_code: input.code,
      language_id: languageIds[input.language],
      stdin: input.stdin,
      cpu_time_limit: 3,
      cpu_extra_time: 1,
      wall_time_limit: 5,
      memory_limit: 128_000,
      stack_limit: 32_000,
      max_processes_and_or_threads: 10,
      max_file_size: 1_024,
      enable_network: false,
      enable_per_process_and_thread_time_limit: false,
      enable_per_process_and_thread_memory_limit: false,
    }),
  }), true)

  let result = submission
  while (!result.status || result.status.id <= 2) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new ExecutionFailure("timeout", "Execution timed out while waiting for the sandbox.")
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollIntervalMs ?? 400, remaining)))
    const token = submission.token!
    result = await readResult(await request(`/submissions/${encodeURIComponent(token)}?base64_encoded=false&fields=stdout,stderr,compile_output,time,status`), false)
  }

  const statusId = result.status.id
  if (statusId === 13 || ![3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14].includes(statusId)) {
    throw new ExecutionFailure("service_error", "Execution service could not complete the request.")
  }
  const status: CodeExecutionResponse["status"] = statusId === 3 ? "accepted"
    : statusId === 5 ? "timeout"
      : statusId === 6 ? "compilation_error" : "runtime_error"
  const stdout = normalizedOutput(result.stdout)
  const stderr = normalizedOutput(result.stderr)
  const compileOutput = normalizedOutput(result.compile_output)
  const parsedTime = result.time == null ? null : Number(result.time)
  const executionTimeMs = parsedTime !== null && Number.isFinite(parsedTime) && parsedTime >= 0 ? Math.round(parsedTime * 1000) : null
  return {
    status,
    stdout: stdout.value,
    stderr: stderr.value,
    compileOutput: compileOutput.value,
    outputTruncated: stdout.truncated || stderr.truncated || compileOutput.truncated,
    executionTimeMs,
    requestTimeMs: Math.round(performance.now() - started),
    success: status === "accepted",
  }
}
