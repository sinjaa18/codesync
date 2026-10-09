import express from "express"
import cors from "cors"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import { z } from "zod"
import * as Y from "yjs"
import executionRoutes from "./routes/execution.route.js"
import authRoutes from "./routes/auth.route.js"
import roomRoutes from "./routes/room.route.js"
import projectRoutes from "./routes/project.route.js"
import type { WSMessage } from "./types/ws.types.js"
import { getSession, onSessionRevoked } from "./auth/store.js"
import type { User } from "./auth/store.js"
import { getRoomPresenceContext, hasRoomAccess, loadRoomDocument, persistRoomUpdate } from "./auth/roomStore.js"
import { prisma } from "./db/client.js"
import { errorHandler, httpRequestLogger, notFoundHandler, requestContext } from "./observability/http.js"
import { createReadinessHandler, healthHandler } from "./observability/health.js"
import { isDatabaseError, logError, logInfo, logWarn, safeCloseReason, safeErrorFields } from "./observability/logger.js"

const app = express()
const port = Number(process.env.PORT) || 5000
const server = createServer(app)
const wss = new WebSocketServer({ server, maxPayload: 1_000_000 })
const rooms = new Map<string, Set<WebSocket>>()
type PresenceCursor = { line: number; column: number } | null
type Presence = { userId: string; username: string; color: string; projectId: string | null; fileId: string | null; filePath: string | null; cursor: PresenceCursor; online: true }
type Membership = { roomId: string; userId: string; scopeKey: string; projectId: string | null; fileId: string | null }
const membership = new Map<WebSocket, Membership>()
const presenceScopes = new Map<string, Map<string, { ws: WebSocket; presence: Presence }>>()
const socketSessions = new Map<WebSocket, string>()
const socketUsers = new Map<WebSocket, User>()
const socketExpiryTimers = new Map<WebSocket, NodeJS.Timeout>()
const roomDocs = new Map<string, Y.Doc>()
const roomDocLoads = new Map<string, Promise<Y.Doc>>()
const roomPersistenceQueues = new Map<string, Promise<void>>()
const allowedOrigins = process.env.CLIENT_ORIGIN?.split(",").map((origin) => origin.trim()) ?? ["http://localhost:5173"]

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("authenticate"), token: z.string().min(40).max(60) }),
  z.object({ type: z.literal("join"), roomId: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/), stateVector: z.string().max(20_000).optional() }),
  z.object({ type: z.literal("doc-update"), roomId: z.string().min(1).max(64), update: z.string().min(4).max(750_000) }),
  z.object({ type: z.literal("presence-update"), cursor: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }).strict().nullable(), userId: z.string().optional() }).strict(),
])

const presenceColors = ["#f28b82", "#fbbc04", "#34a853", "#8ab4f8", "#c58af9", "#ff8bcb", "#78d9ec", "#f6bf76"]

function colorForUser(userId: string) {
  let hash = 0
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return presenceColors[hash % presenceColors.length]!
}

function getRoomDoc(roomId: string) {
  const existing = roomDocs.get(roomId)
  if (existing) return Promise.resolve(existing)
  let loading = roomDocLoads.get(roomId)
  if (!loading) {
    loading = loadRoomDocument(roomId)
    roomDocLoads.set(roomId, loading)
  }
  return loading.then((doc) => {
    roomDocs.set(roomId, doc)
    if (roomDocLoads.get(roomId) === loading) roomDocLoads.delete(roomId)
    return doc
  }).catch((error) => {
    if (roomDocLoads.get(roomId) === loading) roomDocLoads.delete(roomId)
    throw error
  })
}

function decodeBase64(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 data")
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

function send(ws: WebSocket, message: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function broadcast(roomId: string, message: object, sender?: WebSocket) {
  for (const client of rooms.get(roomId) ?? []) {
    if (client !== sender) send(client, message)
  }
}

function broadcastPresence(scopeKey: string, message: object, sender?: WebSocket) {
  for (const entry of presenceScopes.get(scopeKey)?.values() ?? []) {
    if (entry.ws !== sender) send(entry.ws, message)
  }
}

function leaveRoom(ws: WebSocket) {
  const member = membership.get(ws)
  if (!member) return
  const room = rooms.get(member.roomId)
  room?.delete(ws)
  membership.delete(ws)
  const scope = presenceScopes.get(member.scopeKey)
  if (scope?.get(member.userId)?.ws === ws) {
    scope.delete(member.userId)
    if (!scope.size) presenceScopes.delete(member.scopeKey)
    else broadcastPresence(member.scopeKey, { type: "presence-remove", userId: member.userId })
  }
  if (!room?.size) {
    rooms.delete(member.roomId)
    roomDocs.get(member.roomId)?.destroy()
    roomDocs.delete(member.roomId)
  } else {
    broadcast(member.roomId, { type: "user-left", userId: member.userId })
    broadcast(member.roomId, { type: "users", count: room.size })
  }
}

onSessionRevoked((key) => {
  for (const [ws, sessionKey] of socketSessions) {
    if (sessionKey === key) ws.close(1008, "Session revoked")
  }
})

wss.on("connection", (ws, request) => {
  const connectionId = randomUUID()
  const connectedAt = performance.now()
  let authenticatedUserId: string | undefined
  let activeRoomId: string | undefined
  let activeProjectId: string | null = null
  let activeFileId: string | null = null
  let cleanedUp = false
  const origin = request.headers.origin
  if (origin && !allowedOrigins.includes(origin)) {
    logWarn("websocket.connection_rejected", { connectionId, reason: "origin_not_allowed" })
    ws.close(1008, "Origin not allowed")
    return
  }
  logInfo("websocket.connection_accepted", { connectionId })
  const authenticationTimeout = setTimeout(() => {
    logWarn("websocket.authentication_timeout", { connectionId })
    ws.close(1008, "Authentication required")
  }, 5_000)
  ws.on("message", async (raw: RawData) => {
    let stage = "message_validation"
    try {
    let value: unknown
    try {
      value = JSON.parse(raw.toString())
    } catch {
      logWarn("websocket.protocol_rejected", { connectionId, reason: "invalid_json" })
      send(ws, { type: "error", message: "Message must be valid JSON." })
      return
    }
    const result = messageSchema.safeParse(value)
    if (!result.success) {
      logWarn("websocket.protocol_rejected", { connectionId, reason: "invalid_message" })
      send(ws, { type: "error", message: "Invalid message." })
      return
    }
    const message: WSMessage = result.data
    if (message.type === "authenticate") {
      if (socketSessions.has(ws)) {
        logWarn("websocket.authentication_rejected", { connectionId, reason: "already_authenticated", userId: authenticatedUserId })
        ws.close(1008, "Already authenticated")
        return
      }
      stage = "session_lookup"
      const session = await getSession(message.token)
      if (!session) {
        logWarn("websocket.authentication_rejected", { connectionId, reason: "invalid_session" })
        ws.close(1008, "Invalid or expired session")
        return
      }
      clearTimeout(authenticationTimeout)
      socketSessions.set(ws, session.key)
      socketUsers.set(ws, session.user)
      authenticatedUserId = session.user.id
      socketExpiryTimers.set(ws, setTimeout(() => ws.close(1008, "Session expired"), session.expiresAt - Date.now()))
      send(ws, { type: "authenticated", user: session.user })
      logInfo("websocket.authenticated", { connectionId, userId: session.user.id })
      return
    }
    const sessionKey = socketSessions.get(ws)
    const authenticatedUser = socketUsers.get(ws)
    if (!sessionKey || !authenticatedUser) {
      if (!sessionKey) send(ws, { type: "error", message: "Authenticate before sending room messages." })
      else ws.close(1008, "Session expired or revoked")
      return
    }
    if (message.type === "join") {
      let clientStateVector: Uint8Array | undefined
      try {
        if (message.stateVector) {
          clientStateVector = decodeBase64(message.stateVector)
          Y.decodeStateVector(clientStateVector)
        }
      } catch {
        logWarn("websocket.protocol_rejected", { connectionId, userId: authenticatedUser.id, reason: "invalid_state_vector" })
        send(ws, { type: "error", message: "Invalid Yjs state vector." })
        return
      }

      const roomId = message.roomId.trim()
      const userId = authenticatedUser.id
      stage = "room_authorization"
      if (!userId || !await hasRoomAccess(roomId, userId)) {
        logWarn("websocket.room_access_denied", { connectionId, userId, roomId })
        send(ws, { type: "error", message: "You are not authorized to join this room." })
        return
      }
      stage = "room_lookup"
      const context = await getRoomPresenceContext(roomId)
      if (!context) {
        logWarn("websocket.room_access_denied", { connectionId, userId, roomId, reason: "room_not_found" })
        send(ws, { type: "error", message: "The collaboration room no longer exists." })
        return
      }
      const scopeKey = context.projectId ? `project:${context.projectId}` : `room:${roomId}`
      const scope = presenceScopes.get(scopeKey)
      const previousUserSocket = scope?.get(userId)?.ws
      if (previousUserSocket && previousUserSocket !== ws) {
        leaveRoom(previousUserSocket)
        previousUserSocket.close(1000, "Presence moved to another connection")
      }
      leaveRoom(ws)
      stage = "document_load"
      const doc = await getRoomDoc(roomId)
      const room = rooms.get(roomId) ?? new Set<WebSocket>()
      room.add(ws)
      rooms.set(roomId, room)
      roomDocs.set(roomId, doc)
      membership.set(ws, { roomId, userId, scopeKey, projectId: context.projectId, fileId: context.fileId })
      activeRoomId = roomId
      activeProjectId = context.projectId
      activeFileId = context.fileId
      const collaborator: Presence = {
        userId,
        username: authenticatedUser.username,
        color: colorForUser(userId),
        projectId: context.projectId,
        fileId: context.fileId,
        filePath: context.filePath,
        cursor: null,
        online: true,
      }
      const nextScope = presenceScopes.get(scopeKey) ?? new Map<string, { ws: WebSocket; presence: Presence }>()
      nextScope.set(userId, { ws, presence: collaborator })
      presenceScopes.set(scopeKey, nextScope)
      send(ws, {
        type: "joined",
        roomId,
        update: Buffer.from(clientStateVector ? Y.encodeStateAsUpdate(doc, clientStateVector) : Y.encodeStateAsUpdate(doc)).toString("base64"),
        stateVector: Buffer.from(Y.encodeStateVector(doc)).toString("base64"),
        count: room.size,
      })
      send(ws, {
        type: "presence-state",
        collaborators: [...nextScope.values()].map((entry) => entry.presence.fileId === context.fileId
          ? entry.presence
          : { ...entry.presence, cursor: null }),
      })
      broadcastPresence(scopeKey, { type: "presence-update", collaborator }, ws)
      broadcast(roomId, { type: "users", count: room.size }, ws)
      logInfo("websocket.room_joined", { connectionId, userId, projectId: context.projectId, roomId, fileId: context.fileId })
      return
    }

    const member = membership.get(ws)
    if (!member) {
      if (message.type !== "presence-update") logWarn("websocket.protocol_rejected", { connectionId, userId: authenticatedUser.id, reason: "room_not_joined" })
      return
    }
    if (message.type === "doc-update" && message.roomId !== member.roomId) {
      logWarn("websocket.protocol_rejected", { connectionId, userId: member.userId, roomId: member.roomId, reason: "room_mismatch" })
      return
    }
    if (message.type === "doc-update") {
      const doc = roomDocs.get(member.roomId)
      if (!doc) return
      try {
        const update = decodeBase64(message.update)
        Y.applyUpdate(doc, update)
        const content = doc.getText("code").toString()
        const previous = roomPersistenceQueues.get(member.roomId) ?? Promise.resolve()
        const persisted = previous.catch(() => undefined).then(() => persistRoomUpdate(member.roomId, update, content))
        roomPersistenceQueues.set(member.roomId, persisted)
        try {
          await persisted
        } finally {
          if (roomPersistenceQueues.get(member.roomId) === persisted) roomPersistenceQueues.delete(member.roomId)
        }
      } catch (error) {
        logError(isDatabaseError(error) ? "database.websocket_operation_failed" : "websocket.document_update_failed", {
          connectionId, userId: member.userId, projectId: member.projectId, roomId: member.roomId, fileId: member.fileId, operation: "persist_document_update", ...safeErrorFields(error),
        })
        send(ws, { type: "error", message: "The document update could not be applied or saved." })
        return
      }
      broadcast(member.roomId, { ...message, userId: member.userId }, ws)
    } else if (message.type === "presence-update") {
      const entry = presenceScopes.get(member.scopeKey)?.get(member.userId)
      if (!entry || entry.ws !== ws) return
      const collaborator = { ...entry.presence, cursor: message.cursor }
      presenceScopes.get(member.scopeKey)!.set(member.userId, { ws, presence: collaborator })
      if (message.cursor) {
        for (const client of rooms.get(member.roomId) ?? []) {
          if (client !== ws) send(client, { type: "presence-update", collaborator })
        }
      } else {
        broadcastPresence(member.scopeKey, { type: "presence-update", collaborator }, ws)
      }
    }
    } catch (error) {
      logError(isDatabaseError(error) ? "database.websocket_operation_failed" : "websocket.message_failed", {
        connectionId, userId: authenticatedUserId, projectId: activeProjectId, roomId: activeRoomId, fileId: activeFileId, operation: stage, ...safeErrorFields(error),
      })
      send(ws, { type: "error", message: "The server could not process this message." })
    }
  })
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    clearTimeout(authenticationTimeout)
    const expiryTimer = socketExpiryTimers.get(ws)
    if (expiryTimer) clearTimeout(expiryTimer)
    socketExpiryTimers.delete(ws)
    socketSessions.delete(ws)
    socketUsers.delete(ws)
    leaveRoom(ws)
  }
  ws.on("close", (code, reason) => {
    logInfo("websocket.connection_closed", {
      connectionId,
      userId: authenticatedUserId,
      projectId: activeProjectId,
      roomId: activeRoomId,
      fileId: activeFileId,
      closeCode: code,
      reason: safeCloseReason(reason.toString()),
      durationMs: Math.round(performance.now() - connectedAt),
    })
    cleanup()
  })
  ws.on("error", (error) => {
    logError("websocket.connection_error", { connectionId, userId: authenticatedUserId, projectId: activeProjectId, roomId: activeRoomId, fileId: activeFileId, ...safeErrorFields(error) })
    cleanup()
  })
})

app.use(requestContext)
app.use(httpRequestLogger)
app.use(cors({ origin: allowedOrigins }))
app.use(express.json({ limit: "1mb" }))
app.use("/auth", authRoutes)
app.use("/rooms", roomRoutes)
app.use("/projects", projectRoutes)
app.use("/", executionRoutes)
app.get("/", (_req, res) => res.send("CodeSync server is running."))
app.get("/health", healthHandler)
app.get("/ready", createReadinessHandler(() => prisma.$queryRaw`SELECT 1`))
app.use(notFoundHandler)
app.use(errorHandler)

try {
  await prisma.$connect()
  server.listen(port, process.env.HOST, () => logInfo("server.started", { port }))
} catch (error) {
  logError("database.startup_failed", { dependency: "postgresql", ...safeErrorFields(error) })
  process.exitCode = 1
}
