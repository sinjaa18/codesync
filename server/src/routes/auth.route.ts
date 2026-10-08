import { Router } from "express"
import { z } from "zod"
import { getBearerToken, requireAuth } from "../auth/middleware.js"
import { authRateLimit } from "../auth/rateLimit.js"
import { createSession, createUser, findUserById, revokeSession, verifyPassword } from "../auth/store.js"

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
  if (!parsed.success) return res.status(400).json({ error: "Username must be 3–24 letters, numbers, underscores, or hyphens; password must be 10–128 characters." })
  const user = await createUser(parsed.data.username, parsed.data.password)
  if (!user) return res.status(409).json({ error: "That username is already registered." })
  res.status(201).json({ user, ...createSession(user.id) })
})

router.post("/login", authRateLimit, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: "Invalid username or password." })
  const user = await verifyPassword(parsed.data.username, parsed.data.password)
  if (!user) return res.status(401).json({ error: "Invalid username or password." })
  res.json({ user, ...createSession(user.id) })
})

router.post("/logout", requireAuth, (req, res) => {
  const token = getBearerToken(req)
  if (token) revokeSession(token)
  res.status(204).end()
})

router.get("/me", requireAuth, (req, res) => {
  const user = findUserById(res.locals.userId!)
  if (!user) return res.status(401).json({ error: "Session is no longer valid." })
  res.json({ user })
})

export default router
