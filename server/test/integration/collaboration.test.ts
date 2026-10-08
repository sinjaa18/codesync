import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { test } from "node:test"
import * as Y from "yjs"
import WebSocket from "ws"
import { PrismaClient } from "@prisma/client"

let port = 0
let judgePort = 0
const serverLogs: string[] = []
const remoteOrigin = {}
const prisma = new PrismaClient()
const encode = (value: Uint8Array) => Buffer.from(value).toString("base64")
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64"))
type Presence = { userId: string; username: string; color: string; projectId: string | null; fileId: string | null; filePath: string | null; cursor: { line: number; column: number } | null; online: boolean }
type Message = { type: string; message?: string; update?: string; stateVector?: string; count?: number; userId?: string; collaborator?: Presence; collaborators?: Presence[]; cursor?: { line: number; column: number } | null }

function readMessage(raw: WebSocket.RawData): Message | null {
  try {
    return JSON.parse(raw.toString()) as Message
  } catch {
    return null
  }
}

function nextMessage(ws: WebSocket, type: string, timeoutMs = 3_000, matches: (message: Message) => boolean = () => true): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), timeoutMs)
    const onMessage = (raw: WebSocket.RawData) => {
      const message = readMessage(raw)
      if (message?.type === type && matches(message)) finish(undefined, message)
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

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for collaborative state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

type Peer = { ws: WebSocket; doc: Y.Doc; roomId: string; sendUpdate: (update: Uint8Array) => void }

async function availablePort() {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const address = probe.address()
  assert.ok(address && typeof address !== "string")
  const available = address.port
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return available
}

function startServer() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), JUDGE0_API_URL: `http://127.0.0.1:${judgePort}` },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => { const text = chunk.toString(); output += text; serverLogs.push(text) })
  child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); output += text; serverLogs.push(text) })
  return { child, getOutput: () => output }
}

async function waitForServer(running: ReturnType<typeof startServer>) {
  const hasStarted = () => running.getOutput().split(/\r?\n/).some((line) => {
    try {
      const entry = JSON.parse(line) as { event?: string; port?: number }
      return entry.event === "server.started" && entry.port === port
    } catch {
      return false
    }
  })
  const deadline = Date.now() + 15_000
  while (!hasStarted() && Date.now() < deadline) {
    if (running.child.exitCode !== null) throw new Error(`Server exited before startup: ${running.getOutput()}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(hasStarted(), `server should start: ${running.getOutput()}`)
}

async function stopServer(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    child.kill()
  })
}

async function api(path: string, token?: string, body?: unknown, method?: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function signup(username: string) {
  const response = await api("/auth/signup", undefined, { username, password: "test-password-123" })
  assert.equal(response.status, 201)
  return (await response.json()) as { token: string; user: { id: string; username: string } }
}

async function connectPeer(doc: Y.Doc, roomId: string, token: string): Promise<{ peer: Peer; count: number; presence: Presence[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  let joined = false
  const sendUpdate = (update: Uint8Array) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "doc-update", roomId, update: encode(update) }))
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

  const authenticatedMessage = nextMessage(ws, "authenticated")
  ws.send(JSON.stringify({ type: "authenticate", token }))
  await authenticatedMessage
  const joinedMessage = nextMessage(ws, "joined")
  const presenceState = nextMessage(ws, "presence-state")
  ws.send(JSON.stringify({ type: "join", roomId, stateVector: encode(Y.encodeStateVector(doc)) }))
  const response = await joinedMessage
  const currentPresence = await presenceState
  assert.ok(response.update && response.stateVector, "join acknowledgement includes Yjs state and vector")
  Y.applyUpdate(doc, decode(response.update), remoteOrigin)
  joined = true
  const missing = Y.encodeStateAsUpdate(doc, decode(response.stateVector))
  if (missing.length > 2) sendUpdate(missing)
  return { peer: { ws, doc, roomId, sendUpdate }, count: response.count ?? 0, presence: currentPresence.collaborators ?? [] }
}

async function assertSocketRequiresAuthentication() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  const denied = nextMessage(ws, "error")
  ws.send(JSON.stringify({ type: "join", roomId: "shared" }))
  assert.match((await denied).message ?? "", /Authenticate/)
  ws.close()
}

async function assertSocketRoomDenied(token: string, roomId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  const authenticated = nextMessage(ws, "authenticated")
  ws.send(JSON.stringify({ type: "authenticate", token }))
  await authenticated
  const denied = nextMessage(ws, "error")
  ws.send(JSON.stringify({ type: "join", roomId }))
  assert.match((await denied).message ?? "", /not authorized/)
  ws.close()
}

async function assertSocketRejectsInvalidSession() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)))
  ws.send(JSON.stringify({ type: "authenticate", token: "x".repeat(48) }))
  assert.equal(await closed, 1008, "invalid socket sessions are closed with policy code")
}

async function assertSocketRejectsOrigin() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "https://untrusted.example" })
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)))
  assert.equal(await closed, 1008, "disallowed origins are rejected")
}

test("PostgreSQL auth and room data persist while Yjs collaboration converges", { timeout: 60_000 }, async (t) => {
  port = await availablePort()
  judgePort = await availablePort()
  const prefix = `phase3-${randomUUID().slice(0, 8)}-`
  const sharedRoom = `${prefix}shared`
  const isolatedRoom = `${prefix}isolated`
  const judgeSubmissions = new Map<string, Record<string, unknown>>()
  let nextSubmission = 0
  const judge = createServer(async (req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/submissions?")) {
      let body = ""
      for await (const chunk of req) body += chunk.toString()
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (parsed.source_code === "__submit_failure__") {
        res.writeHead(503).end("unavailable")
        return
      }
      const token = `mock-${++nextSubmission}`
      judgeSubmissions.set(token, parsed)
      res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ token }))
      return
    }
    const token = req.url?.split("/")[2]?.split("?")[0]
    const submission = token ? judgeSubmissions.get(token) : undefined
    if (submission?.source_code === "__poll_failure__") {
      res.writeHead(502).end("upstream error")
      return
    }
    const code = String(submission?.source_code ?? "")
    const resultStatus = code === "__compile_error__" ? 6 : code === "__runtime_error__" ? 11 : code === "__timeout__" ? 5 : 3
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      stdout: resultStatus === 3 ? `mock output: ${code}` : null,
      stderr: resultStatus === 11 ? "mock runtime error" : null,
      compile_output: resultStatus === 6 ? "mock compiler error" : null,
      time: "0.012",
      status: { id: resultStatus, description: "Mock result" },
    }))
  })
  await new Promise<void>((resolve) => judge.listen(judgePort, "127.0.0.1", resolve))
  let running = startServer()
  const peers: Peer[] = []
  t.after(async () => {
    for (const peer of peers) if (peer.ws.readyState === WebSocket.OPEN) peer.ws.close()
    await stopServer(running.child)
    await new Promise<void>((resolve) => judge.close(() => resolve()))
    await prisma.user.deleteMany({ where: { usernameNormalized: { startsWith: prefix } } })
    await prisma.$disconnect()
  })
  await waitForServer(running)

  const healthResponse = await api("/health")
  assert.equal(healthResponse.status, 200)
  assert.deepEqual(await healthResponse.json(), { status: "ok" })
  assert.match(healthResponse.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i)
  const suppliedRequestId = "b8fe3a51-cf0f-4ee1-9dde-24f8e8baf710"
  const suppliedIdResponse = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "X-Request-ID": suppliedRequestId } })
  assert.equal(suppliedIdResponse.headers.get("x-request-id"), suppliedRequestId)
  assert.equal((await api("/ready")).status, 200, "readiness succeeds while PostgreSQL is available")

  const ownerName = `${prefix}owner`
  const guestName = `${prefix}guest`
  const outsiderName = `${prefix}outsider`
  assert.equal((await api("/auth/signup", undefined, { username: "x", password: "short" })).status, 400, "invalid signup input is rejected")
  assert.equal((await api("/auth/login", undefined, { username: `${prefix}missing`, password: "incorrect-password" })).status, 401, "unknown accounts cannot log in")
  const ownerAuth = await signup(ownerName)
  const duplicate = await api("/auth/signup", undefined, { username: ownerName.toUpperCase(), password: "test-password-123" })
  assert.equal(duplicate.status, 409, "duplicate usernames are rejected case-insensitively")
  const invalidLogin = await api("/auth/login", undefined, { username: ownerName, password: "incorrect-password" })
  assert.equal(invalidLogin.status, 401, "invalid credentials are rejected")
  assert.equal((await api("/auth/me")).status, 401, "protected endpoints reject anonymous requests")
  assert.equal((await api("/auth/me", "a".repeat(48))).status, 401, "unknown sessions are rejected")
  assert.equal((await api("/run", undefined, { code: "", language: "javascript" })).status, 401, "execution requires authentication")
  const languageResponse = await api("/run/languages")
  assert.deepEqual(await languageResponse.json(), [
    { id: "javascript", name: "JavaScript" },
    { id: "typescript", name: "TypeScript" },
    { id: "python", name: "Python" },
    { id: "cpp", name: "C++" },
    { id: "java", name: "Java" },
  ])
  const login = await api("/auth/login", undefined, { username: ownerName, password: "test-password-123" })
  assert.equal(login.status, 200)
  const ownerToken = ((await login.json()) as { token: string }).token
  assert.equal((await api("/auth/me", ownerToken)).status, 200, "valid sessions access protected endpoints")
  assert.equal((await api("/run", ownerToken, { code: "  ", language: "javascript" })).status, 400, "blank source is rejected")
  assert.equal((await api("/run", ownerToken, { code: "print(1)", language: "python", cpu_time_limit: 100 })).status, 400, "client cannot set sandbox limits")
  const execution = await api("/run", ownerToken, { code: "print(1)", language: "python" })
  assert.equal(execution.status, 200)
  const executionResult = await execution.json() as Record<string, unknown>
  assert.equal(executionResult.status, "accepted")
  assert.equal(executionResult.stdout, "mock output: print(1)")
  assert.equal(executionResult.stderr, "")
  assert.equal(executionResult.compileOutput, "")
  assert.equal(executionResult.outputTruncated, false)
  assert.equal(executionResult.executionTimeMs, 12)
  assert.equal(typeof executionResult.requestTimeMs, "number")
  assert.equal(executionResult.success, true)
  const submitted = [...judgeSubmissions.values()].at(-1)!
  assert.equal(submitted.enable_network, false)
  assert.equal(submitted.cpu_time_limit, 3)
  assert.equal(submitted.language_id, 71)
  assert.equal((await api("/run", ownerToken, { code: "print(1)", language: "rust" })).status, 400, "unsupported languages are rejected")
  assert.equal((await api("/run", ownerToken, { code: "print(1)", language: "python", stdin: "x".repeat(10_001) })).status, 400, "oversized standard input is rejected")
  for (const [source, expected] of [["__compile_error__", "compilation_error"], ["__runtime_error__", "runtime_error"], ["__timeout__", "timeout"]] as const) {
    const response = await api("/run", ownerToken, { code: source, language: "python" })
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { status: string }).status, expected)
  }
  assert.equal((await api("/run", ownerToken, { code: "__submit_failure__", language: "python" })).status, 502, "Judge0 submission errors are normalized")
  assert.equal((await api("/run", ownerToken, { code: "__poll_failure__", language: "python" })).status, 502, "Judge0 polling errors are normalized")
  const simultaneous = await Promise.all(["execution-alpha", "execution-beta"].map((code) => api("/run", ownerToken, { code, language: "javascript" })))
  const simultaneousResults = await Promise.all(simultaneous.map((response) => response.json() as Promise<{ stdout: string }>))
  assert.deepEqual(simultaneousResults.map(({ stdout }) => stdout), ["mock output: execution-alpha", "mock output: execution-beta"], "parallel submissions retain their own results")
  const guestAuth = await signup(guestName)
  const outsiderAuth = await signup(outsiderName)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await api("/run", guestAuth.token, { code: `rate-limit-${attempt}`, language: "javascript" })
    assert.equal(response.status, 200, `execution ${attempt + 1} is within the per-user limit`)
    await response.arrayBuffer()
  }
  assert.equal((await api("/run", guestAuth.token, { code: "rate-limit-over", language: "javascript" })).status, 429, "execution rate limit blocks the eleventh request")
  assert.equal((await api(`/rooms/${sharedRoom}/access`, ownerToken, {})).status, 201, "first authorized member creates the room ACL")
  assert.equal((await api(`/rooms/${sharedRoom}/access`, outsiderAuth.token, {})).status, 403, "uninvited users cannot enter an existing room")
  assert.equal((await api(`/rooms/${sharedRoom}/invites`, ownerToken, { username: guestName })).status, 204)
  assert.equal((await api(`/rooms/${sharedRoom}/invites`, guestAuth.token, { username: outsiderName })).status, 403, "only the owner can change room membership")
  assert.equal((await api(`/rooms/${sharedRoom}/access`, guestAuth.token, {})).status, 200)
  assert.equal((await api(`/rooms/${isolatedRoom}/access`, outsiderAuth.token, {})).status, 201)
  await assertSocketRequiresAuthentication()
  await assertSocketRejectsInvalidSession()
  await assertSocketRejectsOrigin()
  await assertSocketRoomDenied(outsiderAuth.token, sharedRoom)

  const firstDoc = new Y.Doc()
  const { peer: first, count: firstCount } = await connectPeer(firstDoc, sharedRoom, ownerToken)
  peers.push(first)
  assert.equal(firstCount, 1)
  firstDoc.getText("code").delete(0, firstDoc.getText("code").length)
  firstDoc.getText("code").insert(0, "ab")

  const secondDoc = new Y.Doc()
  const { peer: second, count: secondCount } = await connectPeer(secondDoc, sharedRoom, guestAuth.token)
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
  const { peer: isolated } = await connectPeer(isolatedDoc, isolatedRoom, outsiderAuth.token)
  peers.push(isolated)
  assert.equal(isolatedDoc.getText("code").toString(), "console.log('Hello from CodeSync')")
  assert.equal(firstDoc.getText("code").toString(), secondDoc.getText("code").toString())
  assert.equal(isolatedDoc.getText("code").toString(), "console.log('Hello from CodeSync')", "updates do not cross room boundaries")

  assert.equal(first.ws.readyState, WebSocket.OPEN)
  assert.equal(second.ws.readyState, WebSocket.OPEN)
  const cursorReceived = nextMessage(second.ws, "presence-update")
  first.ws.send(JSON.stringify({ type: "presence-update", cursor: { line: 2, column: 4 } }))
  const cursor = await cursorReceived
  assert.equal(cursor.collaborator?.userId, ownerAuth.user.id, "the server derives collaborator identity from the authenticated socket")
  assert.equal(cursor.collaborator?.username, ownerName)
  assert.equal(cursor.collaborator?.cursor?.line, 2)
  assert.equal(cursor.collaborator?.cursor?.column, 4)

  const leaveReceived = nextMessage(second.ws, "user-left")
  const closed = new Promise<void>((resolve) => first.ws.once("close", () => resolve()))
  first.ws.close()
  await Promise.all([leaveReceived, closed])
  firstDoc.getText("code").insert(firstDoc.getText("code").length, "R")
  const { peer: reconnected } = await connectPeer(firstDoc, sharedRoom, ownerToken)
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

  const projectResponse = await api("/projects", ownerToken, { name: `${prefix}project` })
  assert.equal(projectResponse.status, 201, "authenticated users can create projects")
  const project = await projectResponse.json() as { id: string; name: string }
  assert.equal((await api("/projects", outsiderAuth.token)).status, 200)
  assert.deepEqual(await (await api("/projects", outsiderAuth.token)).json(), [], "projects are private until a user is invited")
  assert.equal((await api(`/projects/${"x".repeat(65)}/files`, ownerToken)).status, 400, "overlong project identifiers are rejected")
  assert.equal((await api(`/projects/${project.id}/invites`, ownerToken, { username: guestName })).status, 204, "owners can invite project collaborators")
  assert.equal((await api(`/projects/${project.id}/files`, outsiderAuth.token)).status, 404, "outsiders cannot list project files")
  const fileResponse = await api(`/projects/${project.id}/files`, ownerToken, { path: "src/main.ts" })
  assert.equal(fileResponse.status, 201, "project members can create files")
  const file = await fileResponse.json() as { id: string; path: string; roomId: string; content: string }
  assert.equal((await api(`/projects/${project.id}/files/${file.id}`, outsiderAuth.token, { path: "stolen.ts" }, "PATCH")).status, 404, "outsiders cannot rename project files")
  assert.ok(file.roomId, "each new file gets an isolated collaboration room")
  const otherFileResponse = await api(`/projects/${project.id}/files`, ownerToken, { path: "src/other.ts" })
  assert.equal(otherFileResponse.status, 201)
  const otherFile = await otherFileResponse.json() as { id: string; path: string; roomId: string }
  const thirdFileResponse = await api(`/projects/${project.id}/files`, ownerToken, { path: "src/third.ts" })
  assert.equal(thirdFileResponse.status, 201)
  const thirdFile = await thirdFileResponse.json() as { id: string; path: string; roomId: string }
  assert.equal((await api(`/projects/${project.id}/files`, ownerToken, { path: "../secrets.txt" })).status, 400, "file paths reject traversal")
  assert.equal((await api(`/projects/${project.id}/files`, ownerToken, { path: "src/main.ts" })).status, 409, "duplicate file paths are rejected")
  const guestProjectPeer = await connectPeer(new Y.Doc(), file.roomId, guestAuth.token)
  peers.push(guestProjectPeer.peer)
  assert.equal(guestProjectPeer.peer.doc.getText("code").toString(), "", "a project member can join the file document")
  assert.deepEqual(guestProjectPeer.presence.map(({ userId }) => userId), [guestAuth.user.id], "new collaborators receive the current presence snapshot")
  const ownerOnOtherFileUpdate = nextMessage(guestProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
  const otherFilePeer = await connectPeer(new Y.Doc(), otherFile.roomId, ownerToken)
  peers.push(otherFilePeer.peer)
  const ownerOnOtherFile = (await ownerOnOtherFileUpdate).collaborator!
  assert.equal(ownerOnOtherFile.userId, ownerAuth.user.id)
  assert.equal(ownerOnOtherFile.username, ownerName)
  assert.equal(ownerOnOtherFile.fileId, otherFile.id, "project collaborators see each other's active file")
  assert.equal(ownerOnOtherFile.filePath, otherFile.path)
  let crossFileCursorSeen = false
  const onCrossFileMessage = (raw: WebSocket.RawData) => {
    const message = readMessage(raw)
    if (message?.type === "presence-update" && message.collaborator?.userId === ownerAuth.user.id && message.collaborator.cursor) crossFileCursorSeen = true
  }
  guestProjectPeer.peer.ws.on("message", onCrossFileMessage)
  otherFilePeer.peer.ws.send(JSON.stringify({ type: "presence-update", cursor: { line: 4, column: 2 } }))
  await new Promise((resolve) => setTimeout(resolve, 75))
  guestProjectPeer.peer.ws.off("message", onCrossFileMessage)
  assert.equal(crossFileCursorSeen, false, "cursor coordinates are only sent to collaborators on that file")
  await assertSocketRoomDenied(outsiderAuth.token, file.roomId)
  assert.equal((await api(`/projects/${project.id}/invites`, ownerToken, { username: outsiderName })).status, 204)
  const outsiderProjectPeer = await connectPeer(new Y.Doc(), file.roomId, outsiderAuth.token)
  peers.push(outsiderProjectPeer.peer)
  assert.equal(outsiderProjectPeer.presence.length, 3, "presence state contains all current project collaborators")
  assert.deepEqual(new Set(outsiderProjectPeer.presence.map(({ userId }) => userId)), new Set([ownerAuth.user.id, guestAuth.user.id, outsiderAuth.user.id]))
  const ownerOnFileUpdateForGuest = nextMessage(guestProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
  const ownerOnFileUpdateForOutsider = nextMessage(outsiderProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
  const ownerOnFilePeer = await connectPeer(new Y.Doc(), file.roomId, ownerToken)
  peers.push(ownerOnFilePeer.peer)
  const [ownerForGuest, ownerForOutsider] = await Promise.all([ownerOnFileUpdateForGuest, ownerOnFileUpdateForOutsider])
  assert.equal(ownerForGuest.collaborator?.fileId, file.id, "switching files updates project-wide active-file presence")
  assert.equal(ownerForOutsider.collaborator?.filePath, "src/main.ts")
  assert.equal(ownerOnFilePeer.presence.filter(({ userId }) => userId === ownerAuth.user.id).length, 1, "a user has one presence entry after switching files")
  assert.equal(ownerOnFilePeer.presence.find(({ userId }) => userId === ownerAuth.user.id)?.color, ownerForGuest.collaborator?.color)

  const ownerCursorForGuest = nextMessage(guestProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
  const ownerCursorForOutsider = nextMessage(outsiderProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
  ownerOnFilePeer.peer.ws.send(JSON.stringify({ type: "presence-update", cursor: { line: 2, column: 5 } }))
  const [ownerCursorGuest, ownerCursorOutsider] = await Promise.all([ownerCursorForGuest, ownerCursorForOutsider])
  assert.equal(ownerCursorGuest.collaborator?.userId, ownerAuth.user.id)
  assert.deepEqual(ownerCursorOutsider.collaborator?.cursor, { line: 2, column: 5 })
  const guestCursorForOwner = nextMessage(ownerOnFilePeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === guestAuth.user.id)
  const guestCursorForOutsider = nextMessage(outsiderProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === guestAuth.user.id)
  guestProjectPeer.peer.ws.send(JSON.stringify({ type: "presence-update", cursor: { line: 7, column: 3 } }))
  assert.deepEqual((await guestCursorForOwner).collaborator?.cursor, { line: 7, column: 3 }, "a second user's cursor remains independent")
  const outsiderCursorForOwner = nextMessage(ownerOnFilePeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === outsiderAuth.user.id)
  const outsiderCursorForGuest = nextMessage(guestProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === outsiderAuth.user.id)
  outsiderProjectPeer.peer.ws.send(JSON.stringify({ type: "presence-update", cursor: { line: 12, column: 8 } }))
  assert.deepEqual((await outsiderCursorForOwner).collaborator?.cursor, { line: 12, column: 8 }, "a third user's cursor remains independent")
  assert.equal((await outsiderCursorForGuest).collaborator?.username, outsiderName)
  const spoofIgnored = nextMessage(ownerOnFilePeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === outsiderAuth.user.id && message.collaborator.cursor?.line === 99)
  outsiderProjectPeer.peer.ws.send(JSON.stringify({ type: "presence-update", userId: ownerAuth.user.id, cursor: { line: 99, column: 99 } }))
  const spoofedCursor = await spoofIgnored
  assert.equal(spoofedCursor.collaborator?.userId, outsiderAuth.user.id, "the server ignores a client-supplied identity and uses the authenticated user")
  assert.deepEqual(spoofedCursor.collaborator?.cursor, { line: 99, column: 99 })

  let reconnectingOwner = ownerOnFilePeer.peer
  const stableColor = ownerForGuest.collaborator?.color
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const removedForGuest = nextMessage(guestProjectPeer.peer.ws, "presence-remove")
    const removedForOutsider = nextMessage(outsiderProjectPeer.peer.ws, "presence-remove")
    const socketClosed = new Promise<void>((resolve) => reconnectingOwner.ws.once("close", () => resolve()))
    reconnectingOwner.ws.close()
    await Promise.all([socketClosed, removedForGuest, removedForOutsider])
    const reappearedForGuest = nextMessage(guestProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
    const reappearedForOutsider = nextMessage(outsiderProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
    const reconnectedOwner = await connectPeer(new Y.Doc(), file.roomId, ownerToken)
    peers.push(reconnectedOwner.peer)
    assert.equal(reconnectedOwner.presence.filter(({ userId }) => userId === ownerAuth.user.id).length, 1, "reconnect does not duplicate presence entries")
    assert.equal(reconnectedOwner.presence.find(({ userId }) => userId === ownerAuth.user.id)?.color, stableColor, "user color remains stable across reconnects")
    assert.equal((await reappearedForGuest).collaborator?.userId, ownerAuth.user.id)
    assert.equal((await reappearedForOutsider).collaborator?.userId, ownerAuth.user.id)
    reconnectingOwner = reconnectedOwner.peer
  }

  for (const targetFile of [otherFile, thirdFile, file]) {
    const removedFromGuest = nextMessage(guestProjectPeer.peer.ws, "presence-remove", 3_000, (message) => message.userId === ownerAuth.user.id)
    const removedFromOutsider = nextMessage(outsiderProjectPeer.peer.ws, "presence-remove", 3_000, (message) => message.userId === ownerAuth.user.id)
    const activeForGuest = nextMessage(guestProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
    const activeForOutsider = nextMessage(outsiderProjectPeer.peer.ws, "presence-update", 3_000, (message) => message.collaborator?.userId === ownerAuth.user.id)
    const switchedOwner = await connectPeer(new Y.Doc(), targetFile.roomId, ownerToken)
    peers.push(switchedOwner.peer)
    await Promise.all([removedFromGuest, removedFromOutsider])
    assert.equal((await activeForGuest).collaborator?.fileId, targetFile.id, "file switching broadcasts the active file")
    assert.equal((await activeForOutsider).collaborator?.cursor, null, "switching clears stale cursor state")
    assert.equal(switchedOwner.presence.filter(({ userId }) => userId === ownerAuth.user.id).length, 1)
    reconnectingOwner = switchedOwner.peer
  }

  guestProjectPeer.peer.doc.getText("code").insert(0, "export const ready = true")
  await waitFor(async () => (await prisma.file.findUnique({ where: { id: file.id } }))?.content === "export const ready = true")
  assert.equal(otherFilePeer.peer.doc.getText("code").toString(), "", "edits stay isolated to their file")
  const renamed = await api(`/projects/${project.id}/files/${file.id}`, ownerToken, { path: "src/ready.ts" }, "PATCH")
  assert.equal(renamed.status, 200, "file paths can be renamed")
  assert.equal(((await renamed.json()) as { path: string }).path, "src/ready.ts")
  const disposable = await api(`/projects/${project.id}/files`, guestAuth.token, { path: "scratch.js" })
  assert.equal(disposable.status, 201, "invited editors can create files")
  const disposableFile = await disposable.json() as { id: string }
  assert.equal((await api(`/projects/${project.id}/files/${disposableFile.id}`, guestAuth.token, undefined, "DELETE")).status, 204, "files can be deleted")
  assert.equal((await api(`/projects/${project.id}/files/${disposableFile.id}`, guestAuth.token, undefined, "DELETE")).status, 404, "deleted files stay unavailable")

  const removeOutsider = nextMessage(guestProjectPeer.peer.ws, "presence-remove")
  const outsiderClosed = new Promise<void>((resolve) => outsiderProjectPeer.peer.ws.once("close", () => resolve()))
  outsiderProjectPeer.peer.ws.close()
  await Promise.all([removeOutsider, outsiderClosed])
  const privateProjectResponse = await api("/projects", outsiderAuth.token, { name: `${prefix}private` })
  const privateProject = await privateProjectResponse.json() as { id: string }
  const privateFileResponse = await api(`/projects/${privateProject.id}/files`, outsiderAuth.token, { path: "private.js" })
  const privateFile = await privateFileResponse.json() as { roomId: string }
  const unrelatedPeer = await connectPeer(new Y.Doc(), privateFile.roomId, outsiderAuth.token)
  peers.push(unrelatedPeer.peer)
  assert.deepEqual(unrelatedPeer.presence.map(({ userId }) => userId), [outsiderAuth.user.id], "presence never crosses project boundaries")

  for (const peer of peers) {
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.close()
  }
  await Promise.all(peers.map((peer) => peer.ws.readyState === WebSocket.CLOSED
    ? Promise.resolve()
    : new Promise<void>((resolve) => peer.ws.once("close", () => resolve()))))
  await stopServer(running.child)
  running = startServer()
  await waitForServer(running)
  assert.equal((await api("/auth/me", ownerToken)).status, 200, "account sessions survive a backend restart")
  assert.equal((await api(`/rooms/${sharedRoom}/access`, guestAuth.token, {})).status, 200, "room authorization survives a backend restart")
  const recoveredProject = await prisma.project.findUnique({ where: { id: project.id }, include: { memberships: true, files: true } })
  assert.ok(recoveredProject?.memberships.some((membership) => membership.userId === guestAuth.user.id), "project membership survives a restart")
  assert.equal(recoveredProject?.files.find((entry) => entry.id === file.id)?.content, "export const ready = true", "file content survives a restart")
  assert.equal(recoveredProject?.files.find((entry) => entry.id === file.id)?.path, "src/ready.ts", "file renames survive a restart")
  assert.equal((await api(`/projects/${project.id}/files`, guestAuth.token)).status, 200, "project access survives a restart")
  const recoveredFilePeer = await connectPeer(new Y.Doc(), file.roomId, guestAuth.token)
  peers.push(recoveredFilePeer.peer)
  assert.equal(recoveredFilePeer.peer.doc.getText("code").toString(), "export const ready = true", "each file's Yjs state survives restart")
  const recovered = await connectPeer(new Y.Doc(), sharedRoom, guestAuth.token)
  peers.push(recovered.peer)
  assert.equal(recovered.peer.doc.getText("code").toString(), secondDoc.getText("code").toString(), "persisted Yjs updates restore the latest room document")

  const logoutName = `${prefix}logout`
  const logoutAuth = await signup(logoutName)
  const logoutRoom = `${prefix}logout-room`
  assert.equal((await api(`/rooms/${logoutRoom}/access`, logoutAuth.token, {})).status, 201)
  const logoutPeerResult = await connectPeer(new Y.Doc(), logoutRoom, logoutAuth.token)
  peers.push(logoutPeerResult.peer)
  const logoutClosed = new Promise<void>((resolve) => logoutPeerResult.peer.ws.once("close", () => resolve()))
  assert.equal((await api("/auth/logout", logoutAuth.token, {})).status, 204)
  await logoutClosed
  assert.equal((await api("/auth/me", logoutAuth.token)).status, 401, "logout revokes the session")
  let rateLimited = false
  for (let attempt = 0; attempt < 15 && !rateLimited; attempt += 1) {
    const response = await api("/auth/login", undefined, { username: "missing-user", password: "incorrect-password" })
    rateLimited = response.status === 429
  }
  assert.equal(rateLimited, true, "authentication is rate limited by IP")
  await waitFor(() => serverLogs.join("").includes('"event":"execution.failed"'))
  const capturedLogs = serverLogs.join("")
  for (const event of ["http.request", "auth.request_rejected", "authorization.project_denied", "websocket.connection_accepted", "websocket.connection_rejected", "websocket.authentication_rejected", "websocket.room_access_denied", "websocket.connection_closed", "execution.requested", "execution.completed", "execution.failed", "execution.rate_limited"]) {
    assert.ok(capturedLogs.includes(`"event":"${event}"`), `server logs should include ${event}`)
  }
  for (const secret of [ownerAuth.token, guestAuth.token, outsiderAuth.token, logoutAuth.token, "test-password-123", "print(1)", "execution-alpha", "execution-beta", "__poll_failure__", "source_code"]) {
    assert.ok(!capturedLogs.includes(secret), "server logs must not contain passwords, session tokens, or code")
  }
})
