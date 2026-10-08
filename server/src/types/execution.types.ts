export type CodeExecutionStatus = "accepted" | "compilation_error" | "runtime_error" | "timeout"

export type CodeExecutionResponse = {
  status: CodeExecutionStatus
  stdout: string
  stderr: string
  compileOutput: string
  outputTruncated: boolean
  executionTimeMs: number | null
  requestTimeMs: number
  success: boolean
}

export type CodeExecutionErrorResponse = {
  status: "validation_error" | "service_error" | "timeout"
  error: string
  details?: unknown
  requestTimeMs?: number
}
