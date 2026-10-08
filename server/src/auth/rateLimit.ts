import type { NextFunction, Request, Response } from "express"
import { logWarn } from "../observability/logger.js"

const buckets = new Map<string, { count: number; resetAt: number }>()

export function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now()
  const key = req.ip || "unknown"
  const current = buckets.get(key)
  if (!current || current.resetAt <= now) {
    if (buckets.size > 10_000) {
      for (const [ip, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(ip)
    }
    buckets.set(key, { count: 1, resetAt: now + 60_000 })
    return next()
  }
  if (current.count >= 10) {
    logWarn("auth.rate_limited", { requestId: res.locals.requestId, reason: "attempt_limit" })
    return res.status(429).json({ error: "Too many authentication attempts. Try again in a minute." })
  }
  current.count += 1
  next()
}
