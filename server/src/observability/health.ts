import type { RequestHandler } from "express"
import { logInfo, logWarn, safeErrorFields } from "./logger.js"

export const healthHandler: RequestHandler = (_req, res) => {
  res.json({ status: "ok" })
}

export function createReadinessHandler(checkDatabase: () => Promise<unknown>): RequestHandler {
  let wasReady: boolean | undefined
  return async (_req, res) => {
    try {
      await checkDatabase()
      if (wasReady === false) logInfo("database.readiness_restored", { requestId: res.locals.requestId, dependency: "postgresql" })
      wasReady = true
      res.json({ status: "ready" })
    } catch (error) {
      if (wasReady !== false) {
        logWarn("database.not_ready", { requestId: res.locals.requestId, dependency: "postgresql", ...safeErrorFields(error) })
      }
      wasReady = false
      res.status(503).json({ status: "not_ready", requestId: res.locals.requestId })
    }
  }
}
