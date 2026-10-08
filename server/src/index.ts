import express from "express"
import cors from "cors"
import { createServer } from "node:http"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import { z } from "zod"
import * as Y from "yjs"
import executionRoutes from "./routes/execution.route.js"
import type { WSMessage } from "./types/ws.types.js"

const app = express()
const port = Number(process.env.PORT) || 5000
const server = createServer(app)
const wss = new WebSocketServer({ server, maxPayload: 1_000_000 })
const rooms = new Map<string, Set<WebSocket>>()
const membership = new Map<WebSocket, { roomId: string; userId: string }>()
const roomDocs = new Map<string, Y.Doc>()
const allowedOrigins = process.env.CLIENT_ORIGIN?.split(",").map((origin) => origin.trim()) ?? ["http://localhost:5173"]

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), roomId: z.string().trim().min(1).max(64), userId: z.string().min(1).max(64), stateVector: z.string().max(20_000).optional() }),
  z.object({ type: z.literal("doc-update"), roomId: z.string().min(1).max(64), userId: z.string().min(1).max(64), update: z.string().min(4).max(750_000) }),
  z.object({ type: z.literal("cursor-update"), roomId: z.string().min(1).max(64), userId: z.string().min(1).max(64), line: z.number().int().min(1), column: z.number().int().min(1) }),
])

function createRoomDoc() {
  const doc = new Y.Doc()
  doc.getText("code").insert(0, "console.log('Hello from CodeSync')")
  return doc
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

      leaveRoom(ws)
      const roomId = message.roomId.trim()
      const room = rooms.get(roomId) ?? new Set<WebSocket>()
      const doc = roomDocs.get(roomId) ?? createRoomDoc()
      room.add(ws)
      rooms.set(roomId, room)
      roomDocs.set(roomId, doc)
      membership.set(ws, { roomId, userId: message.userId })
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
    if (!member || message.roomId !== member.roomId || message.userId !== member.userId) return
    if (message.type === "doc-update") {
      const doc = roomDocs.get(member.roomId)
      if (!doc) return
      try {
        Y.applyUpdate(doc, decodeBase64(message.update))
      } catch {
        send(ws, { type: "error", message: "Invalid Yjs document update." })
        return
      }
      broadcast(member.roomId, message, ws)
    } else if (message.type === "cursor-update") {
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
