import type { Request, Response } from "express"
import type { CodeExecutionRequest } from "../validators/execution.validator.js"
import type { CodeExecutionErrorResponse, CodeExecutionResponse } from "../types/execution.types.js"
import { executeCode, ExecutionFailure } from "../execution/runner.js"

export const runCode = async (
  req: Request<Record<string, never>, CodeExecutionResponse | CodeExecutionErrorResponse, CodeExecutionRequest>,
  res: Response<CodeExecutionResponse | CodeExecutionErrorResponse>,
) => {
  try {
    res.json(await executeCode(req.body))
  } catch (error) {
    if (error instanceof ExecutionFailure) {
      const statusCode = error.status === "timeout" ? 504 : 502
      return res.status(statusCode).json({ status: error.status, error: error.message })
    }
    return res.status(502).json({ status: "service_error", error: "Execution service is unavailable. Check the server connection and Judge0 configuration." })
  }
}
