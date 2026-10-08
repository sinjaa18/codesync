import { Router } from "express"
import { z } from "zod"
import { requireAuth } from "../auth/middleware.js"
import { inviteRoomMember, ensureRoomAccess } from "../auth/roomStore.js"
import { findUserByName } from "../auth/store.js"
import { logWarn } from "../observability/logger.js"

const router = Router()
router.use(requireAuth)
const roomIdSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/)

router.post("/:roomId/access", async (req, res) => {
  const parsed = roomIdSchema.safeParse(req.params.roomId)
  if (!parsed.success) return res.status(400).json({ error: "Invalid room ID." })
  const access = await ensureRoomAccess(parsed.data, res.locals.userId!)
  if (!access.allowed) {
    logWarn("authorization.room_access_denied", { requestId: res.locals.requestId, userId: res.locals.userId, roomId: parsed.data })
    return res.status(403).json({ error: "You do not have access to this room. Ask its owner to invite your username." })
  }
  res.status(access.created ? 201 : 200).json({ roomId: parsed.data })
})

router.post("/:roomId/invites", async (req, res) => {
  const roomId = roomIdSchema.safeParse(req.params.roomId)
  const body = z.object({ username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/) }).strict().safeParse(req.body)
  if (!roomId.success || !body.success) return res.status(400).json({ error: "Invalid room ID or username." })
  const user = await findUserByName(body.data.username)
  if (!user) return res.status(404).json({ error: "No account found for that username." })
  if (!await inviteRoomMember(roomId.data, res.locals.userId!, user.id)) {
    logWarn("authorization.room_invite_denied", { requestId: res.locals.requestId, userId: res.locals.userId, roomId: roomId.data })
    return res.status(403).json({ error: "Only the room owner can invite participants." })
  }
  res.status(204).end()
})

export default router
