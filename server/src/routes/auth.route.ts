import { Router } from "express"
import { z } from "zod"
import { getBearerToken, requireAuth } from "../auth/middleware.js"
import { authRateLimit } from "../auth/rateLimit.js"
import { createSession, createUser, findUserById, revokeSession, verifyPassword } from "../auth/store.js"
import { logWarn } from "../observability/logger.js"

const router = Router()
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store")
  next()
})
const credentialsSchema = z.object({
  username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(10).max(128),
}).strict()

router.post("/signup", authRateLimit, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body)
  if (!parsed.success) {
    logWarn("auth.signup_rejected", { requestId: res.locals.requestId, reason: "invalid_input" })
    return res.status(400).json({ error: "Username must be 3–24 letters, numbers, underscores, or hyphens; password must be 10–128 characters." })
  }
  const user = await createUser(parsed.data.username, parsed.data.password)
  if (!user) {
    logWarn("auth.signup_rejected", { requestId: res.locals.requestId, reason: "duplicate_username" })
    return res.status(409).json({ error: "That username is already registered." })
  }
  res.status(201).json({ user, ...(await createSession(user.id)) })
})

router.post("/login", authRateLimit, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body)
  if (!parsed.success) {
    logWarn("auth.login_rejected", { requestId: res.locals.requestId, reason: "invalid_input" })
    return res.status(400).json({ error: "Invalid username or password." })
  }
  const user = await verifyPassword(parsed.data.username, parsed.data.password)
  if (!user) {
    logWarn("auth.login_rejected", { requestId: res.locals.requestId, reason: "invalid_credentials" })
    return res.status(401).json({ error: "Invalid username or password." })
  }
  res.json({ user, ...(await createSession(user.id)) })
})

router.post("/logout", requireAuth, async (req, res) => {
  const token = getBearerToken(req)
  if (token) await revokeSession(token)
  res.status(204).end()
})

router.get("/me", requireAuth, async (_req, res) => {
  const user = await findUserById(res.locals.userId!)
  if (!user) return res.status(401).json({ error: "Session is no longer valid." })
  res.json({ user })
})

export default router
