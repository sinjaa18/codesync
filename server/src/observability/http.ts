import { randomUUID } from "node:crypto"
import type { ErrorRequestHandler, RequestHandler } from "express"
import { isDatabaseError, logError, logInfo, logWarn, safeErrorFields } from "./logger.js"

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const requestContext: RequestHandler = (req, res, next) => {
  const supplied = req.get("x-request-id")
  const requestId = supplied && requestIdPattern.test(supplied) ? supplied : randomUUID()
  res.locals.requestId = requestId
  res.setHeader("X-Request-ID", requestId)
  next()
}

function requestPath(req: Parameters<RequestHandler>[0]) {
  const routePath = req.route?.path
  const path = typeof routePath === "string" ? `${req.baseUrl}${routePath}` : req.path
  return path.replace(/[\r\n\t]/g, "").slice(0, 200) || "/"
}

export const httpRequestLogger: RequestHandler = (req, res, next) => {
  const started = performance.now()
  res.once("finish", () => {
    if ((req.path === "/health" || req.path === "/ready") && res.statusCode < 500) return
    logInfo("http.request", {
      requestId: res.locals.requestId,
      method: req.method,
      path: requestPath(req),
      status: res.statusCode,
      durationMs: Math.round(performance.now() - started),
    })
  })
  next()
}

const clientErrorMessages: Record<number, string> = {
  400: "Invalid request.",
  401: "Authentication required.",
  403: "Request forbidden.",
  404: "Resource not found.",
  413: "Request body is too large.",
  429: "Too many requests.",
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Resource not found.", requestId: res.locals.requestId })
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error)
  const candidateStatus = typeof error === "object" && error !== null && "status" in error ? error.status : undefined
  const status = typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : 500
  const requestId = res.locals.requestId
  const fields = {
    requestId,
    method: req.method,
    path: requestPath(req),
    status,
    ...safeErrorFields(error),
  }
  if (status >= 500) logError(isDatabaseError(error) ? "database.request_failed" : "http.unhandled_error", { ...fields, operation: `${req.method} ${requestPath(req)}` })
  else if (status !== 404) logWarn("http.client_error", fields)
  const errorMessage = status >= 500 ? "Internal server error." : clientErrorMessages[status] ?? "Request failed."
  res.status(status).json({ error: errorMessage, requestId })
}
