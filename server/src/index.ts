import express from "express"
import cors from "cors"
import { createServer } from "node:http"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import { z } from "zod"
import executionRoutes from "./routes/execution.route.js"
import type { WSMessage } from "./types/ws.types.js"

const app = express()
const port = Number(process.env.PORT) || 5000
const server = createServer(app)
const wss = new WebSocketServer({ server, maxPayload: 1_000_000 })
const rooms = new Map<string, Set<WebSocket>>()
const membership = new Map<WebSocket, { roomId: string; userId: string }>()
const roomCode = new Map<string, string>()
const allowedOrigins = process.env.CLIENT_ORIGIN?.split(",").map((origin) => origin.trim()) ?? ["http://localhost:5173"]

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), roomId: z.string().trim().min(1).max(64), userId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("code-update"), roomId: z.string().min(1).max(64), userId: z.string().min(1).max(64), changes: z.string().max(500_000) }),
  z.object({ type: z.literal("cursor-update"), roomId: z.string().min(1).max(64), userId: z.string().min(1).max(64), line: z.number().int().min(1), column: z.number().int().min(1) }),
])

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
    roomCode.delete(member.roomId)
  } else {
    broadcast(member.roomId, { type: "user-left", userId: member.userId })
    broadcast(member.roomId, { type: "users", count: room.size })
  }
}

wss.on("connection", (ws, request) => {
  const origin = request.headers.origin
  if (origin && !allowedOrigins.includes(origin)) {
    ws.close(1008, "Origin not allowed")
    return
  }
  ws.on("message", (raw: RawData) => {
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
    if (message.type === "join") {
      leaveRoom(ws)
      const roomId = message.roomId.trim()
      const room = rooms.get(roomId) ?? new Set<WebSocket>()
      room.add(ws)
      rooms.set(roomId, room)
      membership.set(ws, { roomId, userId: message.userId })
      send(ws, { type: "joined", roomId, code: roomCode.get(roomId) ?? "", count: room.size })
      broadcast(roomId, { type: "users", count: room.size }, ws)
      return
    }

    const member = membership.get(ws)
    if (!member || message.roomId !== member.roomId || message.userId !== member.userId) return
    if (message.type === "code-update") {
      roomCode.set(member.roomId, message.changes)
      broadcast(member.roomId, message, ws)
    } else {
      broadcast(member.roomId, message, ws)
    }
  })
  ws.on("close", () => leaveRoom(ws))
  ws.on("error", () => leaveRoom(ws))
})

app.use(cors({ origin: allowedOrigins }))
app.use(express.json({ limit: "32kb" }))
app.use("/", executionRoutes)
app.get("/", (_req, res) => res.send("CodeSync server is running."))

server.listen(port, () => console.log(`CodeSync server listening on port ${port}`))
