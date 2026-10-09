import { Router } from "express"
import { z } from "zod"
import { requireAuth } from "../auth/middleware.js"
import { inviteRoomMember, ensureRoomAccess, createJoinRequest, getRoomJoinRequests, getRoomJoinRequestStatus, approveRoomJoinRequest, rejectRoomJoinRequest, hasRoomAccess, listRoomChatMessages } from "../auth/roomStore.js"
import { findUserByName, findUserById, wsEvents } from "../auth/store.js"
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

router.post("/:roomId/requests", async (req, res) => {
  const roomId = roomIdSchema.safeParse(req.params.roomId)
  if (!roomId.success) return res.status(400).json({ error: "Invalid room ID." })
  const user = await findUserById(res.locals.userId!)
  if (!user) return res.status(404).json({ error: "User not found." })
  const request = await createJoinRequest(roomId.data, user.id)
  if (!request) return res.status(404).json({ error: "Room not found." })
  if (request.created) wsEvents.emit("join-request", request.ownerId, request.type, request.targetId, user.id, user.username)
  res.status(201).json({ status: "pending", created: request.created })
})

router.get("/:roomId/requests/status", async (req, res) => {
  const roomId = roomIdSchema.safeParse(req.params.roomId)
  if (!roomId.success) return res.status(400).json({ error: "Invalid room ID." })
  const status = await getRoomJoinRequestStatus(roomId.data, res.locals.userId!)
  if (!status) return res.status(404).json({ error: "Room not found." })
  res.json(status)
})

router.get("/:roomId/messages", async (req, res) => {
  const roomId = roomIdSchema.safeParse(req.params.roomId)
  if (!roomId.success) return res.status(400).json({ error: "Invalid room ID." })
  if (!await hasRoomAccess(roomId.data, res.locals.userId!)) return res.status(404).json({ error: "Room not found." })
  res.json(await listRoomChatMessages(roomId.data, 100))
})

router.get("/:roomId/requests", async (req, res) => {
  const roomId = roomIdSchema.safeParse(req.params.roomId)
  if (!roomId.success) return res.status(400).json({ error: "Invalid room ID." })
  const requests = await getRoomJoinRequests(roomId.data, res.locals.userId!)
  res.json(requests)
})

router.post("/:roomId/requests/:username/approve", async (req, res) => {
  const roomId = roomIdSchema.safeParse(req.params.roomId)
  const username = z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/).safeParse(req.params.username)
  if (!roomId.success || !username.success) return res.status(400).json({ error: "Invalid room ID or username." })
  const user = await findUserByName(username.data)
  if (!user) return res.status(404).json({ error: "User not found." })
  const success = await approveRoomJoinRequest(roomId.data, res.locals.userId!, user.id)
  if (!success) return res.status(403).json({ error: "Could not approve request." })
  wsEvents.emit("request-approved", user.id, roomId.data)
  res.status(204).end()
})

router.delete("/:roomId/requests/:username", async (req, res) => {
  const roomId = roomIdSchema.safeParse(req.params.roomId)
  const username = z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/).safeParse(req.params.username)
  if (!roomId.success || !username.success) return res.status(400).json({ error: "Invalid room ID or username." })
  const user = await findUserByName(username.data)
  if (!user) return res.status(404).json({ error: "User not found." })
  const success = await rejectRoomJoinRequest(roomId.data, res.locals.userId!, user.id)
  if (!success) return res.status(403).json({ error: "Could not reject request." })
  wsEvents.emit("request-rejected", user.id, roomId.data)
  res.status(204).end()
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
