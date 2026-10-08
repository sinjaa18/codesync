import { Router } from "express"
import type { Request,Response,NextFunction } from "express"
import type { ZodTypeAny } from "zod"

import { codeSchema } from "../validators/execution.validator.js"
import { runCode } from "../controllers/execution.controller.js"
import { requireAuth } from "../auth/middleware.js"
import { languageOptions } from "../execution/languages.js"

const router = Router()
const requests = new Map<string, { count: number; resetAt: number }>()

const limitExecution = (req: Request, res: Response, next: NextFunction) => {
  const now = Date.now()
  const key = String(res.locals.userId)
  const current = requests.get(key)
  if (!current || current.resetAt <= now) {
    if (requests.size > 10_000) {
      for (const [userId, entry] of requests) if (entry.resetAt <= now) requests.delete(userId)
    }
    requests.set(key, { count: 1, resetAt: now + 60_000 })
    next()
    return
  }
  if (current.count >= 10) {
    res.status(429).json({ error: "Execution limit reached. Try again in a minute." })
    return
  }
  current.count += 1
  next()
}

const validate = (schema: ZodTypeAny) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ status: "validation_error", error: "Invalid code execution request.", details: result.error.format() })
  }
  req.body = result.data
  next()
}

router.get("/run/languages", (_req, res) => res.json(languageOptions))
router.post("/run", requireAuth, validate(codeSchema), limitExecution, runCode)

export default router
