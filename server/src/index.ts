import express from "express"
import cors from "cors"
import { createServer } from "node:http"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import { z } from "zod"
import * as Y from "yjs"
import executionRoutes from "./routes/execution.route.js"
import authRoutes from "./routes/auth.route.js"
import roomRoutes from "./routes/room.route.js"
import type { WSMessage } from "./types/ws.types.js"
import { getSession, onSessionRevoked } from "./auth/store.js"
import type { User } from "./auth/store.js"
import { hasRoomAccess, loadRoomDocument, persistRoomUpdate } from "./auth/roomStore.js"
import { prisma } from "./db/client.js"

const app = express()
const port = Number(process.env.PORT) || 5000
const server = createServer(app)
const wss = new WebSocketServer({ server, maxPayload: 1_000_000 })
const rooms = new Map<string, Set<WebSocket>>()
const membership = new Map<WebSocket, { roomId: string; userId: string }>()
const socketSessions = new Map<WebSocket, string>()
const socketUsers = new Map<WebSocket, User>()
const socketExpiryTimers = new Map<WebSocket, NodeJS.Timeout>()
const roomDocs = new Map<string, Y.Doc>()
const roomDocLoads = new Map<string, Promise<Y.Doc>>()
const allowedOrigins = process.env.CLIENT_ORIGIN?.split(",").map((origin) => origin.trim()) ?? ["http://localhost:5173"]

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("authenticate"), token: z.string().min(40).max(60) }),
  z.object({ type: z.literal("join"), roomId: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/), stateVector: z.string().max(20_000).optional() }),
  z.object({ type: z.literal("doc-update"), roomId: z.string().min(1).max(64), update: z.string().min(4).max(750_000) }),
  z.object({ type: z.literal("cursor-update"), roomId: z.string().min(1).max(64), line: z.number().int().min(1), column: z.number().int().min(1) }),
])

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

function leaveRoom(ws: WebSocket) {
  const member = membership.get(ws)
  if (!member) return
  const room = rooms.get(member.roomId)
  room?.delete(ws)
  membership.delete(ws)
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
  const origin = request.headers.origin
  if (origin && !allowedOrigins.includes(origin)) {
    ws.close(1008, "Origin not allowed")
    return
  }
  const authenticationTimeout = setTimeout(() => ws.close(1008, "Authentication required"), 5_000)
  ws.on("message", async (raw: RawData) => {
    let value: unknown
    try {
      value = JSON.parse(raw.toString())
    } catch {
      send(ws, { type: "error", message: "Message must be valid JSON." })
      return
    }
    const result = messageSchema.safeParse(value)
    if (!result.success) {
      send(ws, { type: "error", message: "Invalid message." })
      return
    }
    const message: WSMessage = result.data
    if (message.type === "authenticate") {
      if (socketSessions.has(ws)) {
        ws.close(1008, "Already authenticated")
        return
      }
      const session = await getSession(message.token)
      if (!session) {
        ws.close(1008, "Invalid or expired session")
        return
      }
      clearTimeout(authenticationTimeout)
      socketSessions.set(ws, session.key)
      socketUsers.set(ws, session.user)
      socketExpiryTimers.set(ws, setTimeout(() => ws.close(1008, "Session expired"), session.expiresAt - Date.now()))
      send(ws, { type: "authenticated", user: session.user })
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
        send(ws, { type: "error", message: "Invalid Yjs state vector." })
        return
      }

      const roomId = message.roomId.trim()
      const userId = authenticatedUser.id
      if (!userId || !await hasRoomAccess(roomId, userId)) {
        send(ws, { type: "error", message: "You are not authorized to join this room." })
        return
      }
      leaveRoom(ws)
      const room = rooms.get(roomId) ?? new Set<WebSocket>()
      const doc = await getRoomDoc(roomId)
      room.add(ws)
      rooms.set(roomId, room)
      roomDocs.set(roomId, doc)
      membership.set(ws, { roomId, userId })
      send(ws, {
        type: "joined",
        roomId,
        update: Buffer.from(clientStateVector ? Y.encodeStateAsUpdate(doc, clientStateVector) : Y.encodeStateAsUpdate(doc)).toString("base64"),
        stateVector: Buffer.from(Y.encodeStateVector(doc)).toString("base64"),
        count: room.size,
      })
      broadcast(roomId, { type: "users", count: room.size }, ws)
      return
    }

    const member = membership.get(ws)
    if (!member || message.roomId !== member.roomId) return
    if (message.type === "doc-update") {
      const doc = roomDocs.get(member.roomId)
      if (!doc) return
      try {
        const update = decodeBase64(message.update)
        Y.applyUpdate(doc, update)
        await persistRoomUpdate(member.roomId, update)
      } catch {
        send(ws, { type: "error", message: "The document update could not be applied or saved." })
        return
      }
      broadcast(member.roomId, { ...message, userId: member.userId }, ws)
    } else if (message.type === "cursor-update") {
      broadcast(member.roomId, { ...message, userId: member.userId }, ws)
    }
  })
  const cleanup = () => {
    clearTimeout(authenticationTimeout)
    const expiryTimer = socketExpiryTimers.get(ws)
    if (expiryTimer) clearTimeout(expiryTimer)
    socketExpiryTimers.delete(ws)
    socketSessions.delete(ws)
    socketUsers.delete(ws)
    leaveRoom(ws)
  }
  ws.on("close", cleanup)
  ws.on("error", cleanup)
})

app.use(cors({ origin: allowedOrigins }))
app.use(express.json({ limit: "32kb" }))
app.use("/auth", authRoutes)
app.use("/rooms", roomRoutes)
app.use("/", executionRoutes)
app.get("/", (_req, res) => res.send("CodeSync server is running."))

try {
  await prisma.$connect()
  server.listen(port, () => console.log(`CodeSync server listening on port ${port}`))
} catch (error) {
  console.error("CodeSync could not connect to PostgreSQL.", error)
  process.exitCode = 1
}
