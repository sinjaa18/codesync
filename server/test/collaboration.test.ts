import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"
import * as Y from "yjs"
import WebSocket from "ws"

const port = 20_000 + Math.floor(Math.random() * 20_000)
const remoteOrigin = {}
const encode = (value: Uint8Array) => Buffer.from(value).toString("base64")
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64"))
type Message = { type: string; update?: string; stateVector?: string; count?: number; userId?: string; line?: number; column?: number }

function readMessage(raw: WebSocket.RawData): Message | null {
  try {
    return JSON.parse(raw.toString()) as Message
  } catch {
    return null
  }
}

function nextMessage(ws: WebSocket, type: string, timeoutMs = 3_000): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), timeoutMs)
    const onMessage = (raw: WebSocket.RawData) => {
      const message = readMessage(raw)
      if (message?.type === type) finish(undefined, message)
    }
    const onClose = () => finish(new Error(`Socket closed while waiting for ${type}`))
    const finish = (error?: Error, message?: Message) => {
      clearTimeout(timeout)
      ws.off("message", onMessage)
      ws.off("close", onClose)
      if (error) reject(error)
      else resolve(message!)
    }
    ws.on("message", onMessage)
    ws.once("close", onClose)
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for collaborative state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

type Peer = { ws: WebSocket; doc: Y.Doc; roomId: string; userId: string; sendUpdate: (update: Uint8Array) => void }

async function connectPeer(doc: Y.Doc, roomId: string, userId: string): Promise<{ peer: Peer; count: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  let joined = false
  const sendUpdate = (update: Uint8Array) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "doc-update", roomId, userId, update: encode(update) }))
    }
  }
  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (joined && origin !== remoteOrigin) sendUpdate(update)
  }
  const onMessage = (raw: WebSocket.RawData) => {
    const message = readMessage(raw)
    if (message?.type === "doc-update" && message.update) {
      try {
        Y.applyUpdate(doc, decode(message.update), remoteOrigin)
      } catch {
        ws.close(1002, "Invalid document update")
      }
    }
  }
  ws.on("message", onMessage)
  doc.on("update", onDocUpdate)
  ws.once("close", () => doc.off("update", onDocUpdate))

  const joinedMessage = nextMessage(ws, "joined")
  ws.send(JSON.stringify({ type: "join", roomId, userId, stateVector: encode(Y.encodeStateVector(doc)) }))
  const response = await joinedMessage
  assert.ok(response.update && response.stateVector, "join acknowledgement includes Yjs state and vector")
  Y.applyUpdate(doc, decode(response.update), remoteOrigin)
  joined = true
  const missing = Y.encodeStateAsUpdate(doc, decode(response.stateVector))
  if (missing.length > 2) sendUpdate(missing)
  return { peer: { ws, doc, roomId, userId, sendUpdate }, count: response.count ?? 0 }
}

test("Yjs collaboration converges concurrent edits and supports join, isolation, cursor, and reconnect", { timeout: 30_000 }, async (t) => {
  const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let serverOutput = ""
  server.stdout.on("data", (chunk: Buffer) => { serverOutput += chunk.toString() })
  server.stderr.on("data", (chunk: Buffer) => { serverOutput += chunk.toString() })
  const peers: Peer[] = []
  t.after(() => {
    for (const peer of peers) if (peer.ws.readyState === WebSocket.OPEN) peer.ws.close()
    server.kill()
  })

  const startupDeadline = Date.now() + 10_000
  while (!serverOutput.includes(`listening on port ${port}`) && Date.now() < startupDeadline) {
    if (server.exitCode !== null) throw new Error(`Server exited before startup: ${serverOutput}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(serverOutput.includes(`listening on port ${port}`), `server should start: ${serverOutput}`)

  const firstDoc = new Y.Doc()
  const { peer: first, count: firstCount } = await connectPeer(firstDoc, "shared", "first")
  peers.push(first)
  assert.equal(firstCount, 1)
  firstDoc.getText("code").delete(0, firstDoc.getText("code").length)
  firstDoc.getText("code").insert(0, "ab")

  const secondDoc = new Y.Doc()
  const { peer: second, count: secondCount } = await connectPeer(secondDoc, "shared", "second")
  peers.push(second)
  assert.equal(secondCount, 2)
  assert.equal(secondDoc.getText("code").toString(), "ab", "a new member gets the existing document")

  const commonVector = Y.encodeStateVector(firstDoc)
  let sendFirstUpdates = false
  let sendSecondUpdates = false
  const firstListener = (update: Uint8Array, origin: unknown) => {
    if (sendFirstUpdates && origin !== remoteOrigin) first.sendUpdate(update)
  }
  const secondListener = (update: Uint8Array, origin: unknown) => {
    if (sendSecondUpdates && origin !== remoteOrigin) second.sendUpdate(update)
  }
  firstDoc.on("update", firstListener)
  secondDoc.on("update", secondListener)
  firstDoc.getText("code").insert(1, "A")
  secondDoc.getText("code").insert(1, "B")
  sendFirstUpdates = true
  sendSecondUpdates = true
  first.sendUpdate(Y.encodeStateAsUpdate(firstDoc, commonVector))
  second.sendUpdate(Y.encodeStateAsUpdate(secondDoc, commonVector))
  await waitFor(() => firstDoc.getText("code").toString() === secondDoc.getText("code").toString())
  const merged = firstDoc.getText("code").toString()
  assert.equal(merged.length, 4)
  assert.ok(merged.includes("A") && merged.includes("B"), "both simultaneous inserts are preserved")
  firstDoc.off("update", firstListener)
  secondDoc.off("update", secondListener)

  const isolatedDoc = new Y.Doc()
  const { peer: isolated } = await connectPeer(isolatedDoc, "separate", "isolated")
  peers.push(isolated)
  assert.equal(isolatedDoc.getText("code").toString(), "console.log('Hello from CodeSync')")
  assert.equal(firstDoc.getText("code").toString(), secondDoc.getText("code").toString())
  assert.equal(isolatedDoc.getText("code").toString(), "console.log('Hello from CodeSync')", "updates do not cross room boundaries")

  const cursorReceived = nextMessage(second.ws, "cursor-update")
  first.ws.send(JSON.stringify({ type: "cursor-update", roomId: "shared", userId: "first", line: 2, column: 4 }))
  const cursor = await cursorReceived
  assert.equal(cursor.line, 2)
  assert.equal(cursor.column, 4)

  const leaveReceived = nextMessage(second.ws, "user-left")
  const closed = new Promise<void>((resolve) => first.ws.once("close", () => resolve()))
  first.ws.close()
  await Promise.all([leaveReceived, closed])
  firstDoc.getText("code").insert(firstDoc.getText("code").length, "R")
  const { peer: reconnected } = await connectPeer(firstDoc, "shared", "first")
  peers.push(reconnected)
  await waitFor(() => secondDoc.getText("code").toString() === firstDoc.getText("code").toString())
  assert.ok(secondDoc.getText("code").toString().endsWith("R"), "offline changes are reconciled after reconnect")

  const latencies: number[] = []
  for (let index = 0; index < 10; index += 1) {
    const nextText = `${reconnected.doc.getText("code").toString()}!`
    const startedAt = performance.now()
    reconnected.doc.getText("code").insert(reconnected.doc.getText("code").length, "!")
    await waitFor(() => secondDoc.getText("code").toString() === nextText)
    latencies.push(performance.now() - startedAt)
  }
  latencies.sort((a, b) => a - b)
  t.diagnostic(`Local WebSocket Yjs sync: 10 sequential updates; p50 ${latencies[4].toFixed(2)} ms, p95 ${latencies[9].toFixed(2)} ms.`)
})
