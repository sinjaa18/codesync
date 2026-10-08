export type LogLevel = "info" | "warn" | "error"

const allowedFields = new Set([
  "requestId", "method", "path", "status", "durationMs", "userId", "projectId", "roomId", "fileId",
  "connectionId", "closeCode", "errorType", "errorCode", "stage", "reason", "executionId",
  "executionStatus", "language", "port", "dependency", "operation",
])

type LogValue = string | number | boolean | null

function safeFields(fields: Record<string, unknown>) {
  const result: Record<string, LogValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key)) continue
    if (typeof value === "string") {
      const safeValue = value.replace(/[\r\n\t]/g, " ").slice(0, 200)
      if (safeValue) result[key] = safeValue
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value
    } else if (typeof value === "boolean" || value === null) {
      result[key] = value
    }
  }
  return result
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event: event.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80),
    ...safeFields(fields),
  }
  const line = JSON.stringify(record)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.info(line)
}

export const logInfo = (event: string, fields?: Record<string, unknown>) => log("info", event, fields)
export const logWarn = (event: string, fields?: Record<string, unknown>) => log("warn", event, fields)
export const logError = (event: string, fields?: Record<string, unknown>) => log("error", event, fields)

export function safeErrorFields(error: unknown) {
  const fields: Record<string, unknown> = {
    errorType: error instanceof Error && /^[A-Za-z0-9_.-]{1,60}$/.test(error.name) ? error.name : "UnknownError",
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code
    if (typeof code === "string" && /^(?:P\d{4}|E[A-Z0-9_]{1,20})$/.test(code)) fields.errorCode = code
  }
  return fields
}

export function isDatabaseError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  if ("name" in error && typeof error.name === "string" && error.name.toLowerCase().includes("prisma")) return true
  return "code" in error && typeof error.code === "string" && /^P\d{4}$/.test(error.code)
}

export function safeCloseReason(reason: string) {
  const knownReasons = new Set([
    "Session revoked", "Session expired", "Presence moved to another connection", "Origin not allowed",
    "Authentication required", "Invalid or expired session", "Already authenticated", "Internal error",
  ])
  return knownReasons.has(reason) ? reason : "client_or_unknown"
}
