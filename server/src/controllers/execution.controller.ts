import { randomUUID } from "node:crypto"
import type { Request, Response } from "express"
import type { CodeExecutionRequest } from "../validators/execution.validator.js"
import type { CodeExecutionErrorResponse, CodeExecutionResponse } from "../types/execution.types.js"
import { executeCode, ExecutionFailure } from "../execution/runner.js"
import { logError, logInfo, logWarn, safeErrorFields } from "../observability/logger.js"

export const runCode = async (
  req: Request<Record<string, never>, CodeExecutionResponse | CodeExecutionErrorResponse, CodeExecutionRequest>,
  res: Response<CodeExecutionResponse | CodeExecutionErrorResponse>,
) => {
  const executionId = randomUUID()
  const context = { requestId: res.locals.requestId, userId: res.locals.userId, executionId, language: req.body.language }
  logInfo("execution.requested", context)
  try {
    const result = await executeCode(req.body)
    const resultFields = { ...context, executionStatus: result.status, durationMs: result.requestTimeMs }
    if (result.status === "timeout") logWarn("execution.completed", resultFields)
    else logInfo("execution.completed", resultFields)
    return res.json(result)
  } catch (error) {
    if (error instanceof ExecutionFailure) {
      const fields = { ...context, stage: error.stage, executionStatus: error.status, ...safeErrorFields(error) }
      if (error.status === "timeout") logWarn("execution.failed", fields)
      else logError("execution.failed", fields)
      const statusCode = error.status === "timeout" ? 504 : 502
      return res.status(statusCode).json({ status: error.status, error: error.message })
    }
    logError("execution.failed", { ...context, stage: "unknown", ...safeErrorFields(error) })
    return res.status(502).json({ status: "service_error", error: "Execution service is unavailable. Check the server connection and Judge0 configuration." })
  }
}
