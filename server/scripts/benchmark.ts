import { createHash, randomBytes, scryptSync } from "node:crypto"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import { createServer } from "node:http"
import os from "node:os"
import { performance } from "node:perf_hooks"
import * as Y from "yjs"
import WebSocket from "ws"
import { parseBenchmarkOptions, assertSafeBenchmarkTarget } from "../src/benchmark/safety.js"

const stages = [1, 5, 10, 25]
const maxRequestMs = 10_000
const socketTimeoutMs = 8_000
const messageTimeoutMs = 2_500
const presenceIntervalMs = 50
const presenceWaves = 10
const collabRounds = 3
const randomPrefix = `bench_${randomBytes(6).toString("hex")}`
let activePhase = "configuration"
let benchmarkDeadline = Number.POSITIVE_INFINITY
const safeServerEventCounts: Record<string, number> = {}

type BenchUser = { id: string; token: string }
type BenchMessage = {
  type?: string
  message?: string
  roomId?: string
  update?: string
  stateVector?: string
  userId?: string
  collaborator?: { userId?: string; cursor?: { line: number; column: number } | null }
}
type SocketWaiter = {
  matches: (message: BenchMessage) => boolean
  resolve: (value: { message: BenchMessage; receivedAt: number }) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
type BenchPeer = {
  ws: WebSocket
  userId: string
  roomId: string
  doc: Y.Doc
  waiters: Set<SocketWaiter>
  joined: boolean
  expectedClose: boolean
  closedUnexpectedly: boolean
  receivedDocUpdates: number
  crossRoomUpdates: number
  protocolErrors: number
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null
  if (quantile === 0.95 && values.length < 20) return null
  if (quantile === 0.99 && values.length < 100) return null
  const sorted = [...values].sort((a, b) => a - b)
  return round(sorted[Math.ceil(quantile * sorted.length) - 1]!)
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function latencySummary(values: number[]) {
  return {
    sampleCount: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  }
}

function statsForTimes(times: number[], errors: number, durationMs: number) {
  return {
    ...latencySummary(times),
    successfulOperations: times.length,
    failedOperations: errors,
    errorRate: times.length + errors ? round(errors / (times.length + errors)) : 0,
    durationMs: round(durationMs),
    throughputPerSecond: durationMs > 0 ? round(times.length / (durationMs / 1000)) : 0,
  }
}

function cpuCounters() {
  const cores = os.cpus()
  let idle = 0
  let total = 0
  for (const core of cores) {
    idle += core.times.idle
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq
  }
  return { idle, total }
}

class ResourceSampler {
  private timer: NodeJS.Timeout | undefined
  private last = cpuCounters()
  private maxSystemCpuPercent: number | null = null
  private minAvailableMemoryBytes = os.freemem()
  private maxBenchmarkProcessRssBytes = process.memoryUsage().rss

  start() {
    this.timer = setInterval(() => this.sample(), 250)
    this.timer.unref()
  }

  private sample() {
    const current = cpuCounters()
    const totalDelta = current.total - this.last.total
    const idleDelta = current.idle - this.last.idle
    if (totalDelta > 0) {
      const cpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
      this.maxSystemCpuPercent = Math.max(this.maxSystemCpuPercent ?? 0, cpuPercent)
    }
    this.last = current
    this.minAvailableMemoryBytes = Math.min(this.minAvailableMemoryBytes, os.freemem())
    this.maxBenchmarkProcessRssBytes = Math.max(this.maxBenchmarkProcessRssBytes, process.memoryUsage().rss)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.sample()
    return {
      peakSystemCpuPercent: this.maxSystemCpuPercent === null ? null : round(this.maxSystemCpuPercent),
      minimumAvailableMemoryBytes: this.minAvailableMemoryBytes,
      benchmarkProcessPeakRssBytes: this.maxBenchmarkProcessRssBytes,
    }
  }
}

function startResources() {
  const sampler = new ResourceSampler()
  sampler.start()
  return sampler
}

function nextTurn(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requestTimeoutMs(maxMs: number) {
  const remaining = benchmarkDeadline - performance.now()
  if (remaining <= 0) throw new Error("The benchmark reached its three-minute runtime limit.")
  return Math.max(1, Math.min(maxMs, Math.ceil(remaining)))
}

async function bounded<T>(operation: Promise<T>, maxMs: number) {
  const timeoutMs = requestTimeoutMs(maxMs)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("A local benchmark operation exceeded its time limit.")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function availablePort() {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a local benchmark port.")
  const port = address.port
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForServer(child: ChildProcess, baseUrl: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The local benchmark server exited during startup.")
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(requestTimeoutMs(1_000)) })
      if (response.status === 200) return
    } catch {
      // The process may need a brief moment to bind its local port.
    }
    await nextTurn(100)
  }
  throw new Error("The local benchmark server did not become ready within 15 seconds.")
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill()
  await Promise.race([stopped, nextTurn(2_000)])
  if (child.exitCode === null) child.kill("SIGKILL")
}

async function request(baseUrl: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(requestTimeoutMs(maxRequestMs)),
  })
  return response
}

async function requestJson(baseUrl: string, path: string, token: string | undefined, body: unknown, expectedStatus: number) {
  const response = await request(baseUrl, path, token, body)
  if (response.status !== expectedStatus) throw new Error(`Benchmark setup HTTP operation returned status ${response.status}.`)
  return response.json() as Promise<Record<string, unknown>>
}

async function createBenchUser(prisma: typeof import("../src/db/client.js").prisma, index: number): Promise<BenchUser> {
  const username = `${randomPrefix}_${index}`
  const salt = randomBytes(16).toString("hex")
  const passwordHash = scryptSync(randomBytes(32), salt, 64).toString("hex")
  const user = await prisma.user.create({
    data: { username, usernameNormalized: username.toLowerCase(), passwordSalt: salt, passwordHash },
    select: { id: true },
  })
  const token = randomBytes(32).toString("base64url")
  const id = createHash("sha256").update(token).digest("hex")
  await prisma.session.create({ data: { id, userId: user.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } })
  return { id: user.id, token }
}

function socketWait(peer: BenchPeer, matches: (message: BenchMessage) => boolean, timeoutMs = socketTimeoutMs) {
  const boundedTimeout = requestTimeoutMs(timeoutMs)
  return new Promise<{ message: BenchMessage; receivedAt: number }>((resolve, reject) => {
    const waiter: SocketWaiter = {
      matches,
      resolve: (value) => {
        clearTimeout(waiter.timer)
        peer.waiters.delete(waiter)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(waiter.timer)
        peer.waiters.delete(waiter)
        reject(error)
      },
      timer: setTimeout(() => waiter.reject(new Error("Timed out waiting for a local WebSocket benchmark event.")), boundedTimeout),
    }
    peer.waiters.add(waiter)
  })
}

function decodeMessage(raw: WebSocket.RawData): BenchMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw.toString())
    return typeof value === "object" && value !== null ? value as BenchMessage : undefined
  } catch {
    return undefined
  }
}

async function connectPeer(baseUrl: string, token: string, userId: string, roomId: string, join = true) {
  const connectStarted = performance.now()
  const peer: BenchPeer = {
    ws: new WebSocket(baseUrl.replace(/^http/, "ws")),
    userId,
    roomId,
    doc: new Y.Doc(),
    waiters: new Set(),
    joined: false,
    expectedClose: false,
    closedUnexpectedly: false,
    receivedDocUpdates: 0,
    crossRoomUpdates: 0,
    protocolErrors: 0,
  }
  peer.ws.on("message", (raw) => {
    const message = decodeMessage(raw)
    if (!message) return
    const receivedAt = performance.now()
    if (message.type === "error") peer.protocolErrors += 1
    if (message.type === "doc-update" && message.update) {
      if (message.roomId !== peer.roomId) peer.crossRoomUpdates += 1
      else {
        peer.receivedDocUpdates += 1
        try {
          Y.applyUpdate(peer.doc, new Uint8Array(Buffer.from(message.update, "base64")))
        } catch {
          peer.protocolErrors += 1
        }
      }
    }
    for (const waiter of [...peer.waiters]) {
      if (waiter.matches(message)) waiter.resolve({ message, receivedAt })
    }
  })
  peer.ws.once("close", () => {
    if (peer.joined && !peer.expectedClose) peer.closedUnexpectedly = true
    for (const waiter of [...peer.waiters]) waiter.reject(new Error("Local WebSocket benchmark peer disconnected."))
  })
  peer.ws.on("error", () => {
    if (peer.joined && !peer.expectedClose) peer.closedUnexpectedly = true
    for (const waiter of [...peer.waiters]) waiter.reject(new Error("Local WebSocket benchmark peer reported an error."))
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Timed out opening a local WebSocket benchmark connection.")), requestTimeoutMs(socketTimeoutMs))
      const onError = () => finish(new Error("Could not open a local WebSocket benchmark connection."))
      const onOpen = () => finish()
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        peer.ws.off("error", onError)
        peer.ws.off("open", onOpen)
        if (error) reject(error)
        else resolve()
      }
      peer.ws.once("error", onError)
      peer.ws.once("open", onOpen)
    })
    const openedAt = performance.now()
    const authWait = socketWait(peer, (message) => message.type === "authenticated" || message.type === "error")
    peer.ws.send(JSON.stringify({ type: "authenticate", token }))
    const authResult = await authWait
    if (authResult.message.type !== "authenticated") throw new Error("Local WebSocket benchmark authentication was rejected.")
    const authenticatedAt = authResult.receivedAt
    if (join) {
      const joinWait = socketWait(peer, (message) => message.type === "joined" || message.type === "error")
      const stateVector = Buffer.from(Y.encodeStateVector(peer.doc)).toString("base64")
      peer.ws.send(JSON.stringify({ type: "join", roomId, stateVector }))
      const joinResult = await joinWait
      if (joinResult.message.type !== "joined" || !joinResult.message.update) {
        throw new Error("Local WebSocket benchmark room join was rejected.")
      }
      if (joinResult.message.roomId !== roomId) throw new Error("Local WebSocket benchmark joined an unexpected room.")
      Y.applyUpdate(peer.doc, new Uint8Array(Buffer.from(joinResult.message.update, "base64")))
      peer.joined = true
      return {
        peer,
        connectionMs: round(openedAt - connectStarted),
        authenticationMs: round(authenticatedAt - openedAt),
        joinMs: round(joinResult.receivedAt - authenticatedAt),
        totalSetupMs: round(joinResult.receivedAt - connectStarted),
      }
    }
    return {
      peer,
      connectionMs: round(openedAt - connectStarted),
      authenticationMs: round(authenticatedAt - openedAt),
      joinMs: null,
      totalSetupMs: round(authenticatedAt - connectStarted),
    }
  } catch (error) {
    peer.expectedClose = true
    peer.ws.terminate()
    throw error
  }
}

async function closePeer(peer: BenchPeer) {
  peer.expectedClose = true
  if (peer.ws.readyState === WebSocket.CLOSED) return
  const closed = new Promise<void>((resolve) => peer.ws.once("close", () => resolve()))
  if (peer.ws.readyState === WebSocket.OPEN) peer.ws.close(1000, "benchmark complete")
  else peer.ws.terminate()
  await Promise.race([closed, nextTurn(1_000)])
  if ((peer.ws as WebSocket).readyState !== WebSocket.CLOSED) peer.ws.terminate()
}

function waitForPeerUpdate(peer: BenchPeer, encodedUpdate: string) {
  const startedAt = { value: 0 }
  const wait = socketWait(peer, (message) => message.type === "doc-update" && message.roomId === peer.roomId && message.update === encodedUpdate, messageTimeoutMs)
  return {
    wait: wait.then(({ receivedAt }) => round(receivedAt - startedAt.value)),
    markSent: (value: number) => { startedAt.value = value },
  }
}

function waitForPresence(peer: BenchPeer, userId: string, line: number, column: number) {
  const startedAt = { value: 0 }
  const wait = socketWait(peer, (message) => message.type === "presence-update"
    && message.collaborator?.userId === userId
    && message.collaborator.cursor?.line === line
    && message.collaborator.cursor?.column === column)
  return {
    wait: wait.then(({ receivedAt }) => round(receivedAt - startedAt.value)),
    markSent: (value: number) => { startedAt.value = value },
  }
}

async function observeHealth(baseUrl: string) {
  const started = performance.now()
  const [health, ready] = await Promise.all([
    fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(requestTimeoutMs(maxRequestMs)) }),
    fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(requestTimeoutMs(maxRequestMs)) }),
  ])
  return { healthy: health.status === 200, ready: ready.status === 200, durationMs: round(performance.now() - started) }
}

function routeStages(maxClients: number) {
  return stages.filter((count) => count <= maxClients).concat(maxClients !== 1 && !stages.includes(maxClients) ? [maxClients] : []).sort((a, b) => a - b)
}

async function main(options: ReturnType<typeof parseBenchmarkOptions>) {
  benchmarkDeadline = performance.now() + 180_000
  activePhase = "safe Prisma migration deployment"
  const prismaCli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js")
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    timeout: requestTimeoutMs(30_000),
  })
  const [{ prisma }, { persistRoomUpdate }] = await Promise.all([
    import("../src/db/client.js"),
    import("../src/auth/roomStore.js"),
  ])
  const failures: string[] = []
  const fixtureUserIds: string[] = []
  const openPeers = new Set<BenchPeer>()
  let child: ChildProcess | undefined
  let baseUrl: string | undefined
  let owner: BenchUser | undefined
  let outsider: BenchUser | undefined
  let projectA: Record<string, unknown> | undefined
  let projectB: Record<string, unknown> | undefined
  let fileA: Record<string, unknown> | undefined
  let fileB: Record<string, unknown> | undefined
  const allUsers: BenchUser[] = []
  let report: Record<string, unknown> | undefined

  try {
    activePhase = "fixture setup"
    const versionRows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`
    const postgresVersion = versionRows[0]?.version.match(/PostgreSQL ([\d.]+)/)?.[1] ?? "unknown"
    const databaseTarget = new URL(process.env.DATABASE_URL!)
    const resourceSampler = startResources()
    const setupStarted = performance.now()

    for (let index = 0; index < options.maxClients; index += 1) {
      const user = await createBenchUser(prisma, index)
      allUsers.push(user)
      fixtureUserIds.push(user.id)
    }
    outsider = await createBenchUser(prisma, options.maxClients)
    fixtureUserIds.push(outsider.id)
    owner = allUsers[0]
    if (!owner) throw new Error("Could not create a benchmark owner.")

    const createProject = async (name: string) => requestJson(baseUrl!, "/projects", owner!.token, { name }, 201)
    const serverPort = await availablePort()
    baseUrl = `http://127.0.0.1:${serverPort}`
    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(serverPort), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let serverOutput = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString()
      const lines = serverOutput.split(/\r?\n/)
      serverOutput = lines.pop() ?? ""
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as { event?: unknown }
          if (typeof record.event === "string" && /^[a-z._-]+$/.test(record.event)) {
            safeServerEventCounts[record.event] = (safeServerEventCounts[record.event] ?? 0) + 1
          }
        } catch {
          // Ignore non-structured output; never copy raw server output into benchmark results.
        }
      }
    })
    child.stderr?.on("data", () => undefined)
    await waitForServer(child, baseUrl)

    projectA = await createProject(`${randomPrefix}a`)
    projectB = await createProject(`${randomPrefix}b`)
    await prisma.projectMembership.createMany({
      data: allUsers.flatMap((user) => [projectA!, projectB!].map((project) => ({
        projectId: String(project.id),
        userId: user.id,
        role: "EDITOR" as const,
      }))),
      skipDuplicates: true,
    })
    const createFile = (projectId: string, path: string) => requestJson(baseUrl!, `/projects/${projectId}/files`, owner!.token, { path }, 201)
    fileA = await createFile(String(projectA.id), "src/benchmark.ts")
    fileB = await createFile(String(projectB.id), "src/other.ts")
    const setupResources = resourceSampler.stop()
    const setupDurationMs = round(performance.now() - setupStarted)
    const websocketWarmup = await connectPeer(baseUrl, owner.token, owner.id, String(fileA.roomId))
    openPeers.add(websocketWarmup.peer)
    await closePeer(websocketWarmup.peer)
    openPeers.delete(websocketWarmup.peer)

    activePhase = "HTTP warm-up and baseline"
    const endpoints = [
      { name: "authenticated_project_list", path: "/projects" },
      { name: "authenticated_project_file_list", path: `/projects/${projectA.id}/files` },
    ]
    for (const endpoint of endpoints) {
      for (let warmup = 0; warmup < 5; warmup += 1) {
        const response = await request(baseUrl, endpoint.path, owner.token)
        await response.arrayBuffer()
        if (response.status !== 200) throw new Error(`HTTP warm-up failed for ${endpoint.name}.`)
      }
    }

    const httpResults: Record<string, unknown>[] = []
    let httpAbortedAt: number | undefined
    for (const concurrency of routeStages(options.maxClients)) {
      const sampler = startResources()
      const endpointRows: Record<string, unknown>[] = []
      let stageErrors = 0
      const stageTimes: number[] = []
      for (const endpoint of endpoints) {
        const repetitions: Record<string, unknown>[] = []
        const allTimes: number[] = []
        let totalErrors = 0
        let totalDurationMs = 0
        for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
          let next = 0
          const times: number[] = []
          let errors = 0
          const started = performance.now()
          const workers = Array.from({ length: Math.min(concurrency, options.requestsPerRepetition) }, async () => {
            while (next < options.requestsPerRepetition) {
              const requestIndex = next++
              const requestStarted = performance.now()
              try {
                const response = await request(baseUrl!, endpoint.path, owner!.token)
                await response.arrayBuffer()
                if (response.status !== 200) errors += 1
                else times[requestIndex] = performance.now() - requestStarted
              } catch {
                errors += 1
              }
            }
          })
          await Promise.all(workers)
          const durationMs = performance.now() - started
          const validTimes = times.filter(Number.isFinite)
          allTimes.push(...validTimes)
          stageTimes.push(...validTimes)
          totalErrors += errors
          stageErrors += errors
          totalDurationMs += durationMs
          repetitions.push({ ...statsForTimes(validTimes, errors, durationMs), repetition: repetition + 1 })
        }
        httpResults.push({
          endpoint: endpoint.name,
          requestedConcurrency: concurrency,
          achievedConcurrency: concurrency,
          warmupRequests: 5,
          ...statsForTimes(allTimes, totalErrors, totalDurationMs),
          repetitions,
        })
        endpointRows.push(httpResults[httpResults.length - 1]!)
      }
      const resources = sampler.stop()
      for (const row of endpointRows) {
        ;(row as { resourceObservations?: unknown }).resourceObservations = resources
      }
      if (stageErrors) failures.push(`HTTP stage concurrency ${concurrency} had ${stageErrors} unsuccessful requests.`)
      const maximumP95 = Math.max(0, ...endpointRows.map((row) => Number((row as { p95Ms: number | null }).p95Ms ?? 0)))
      if (stageErrors || maximumP95 > 1_000 || (resources.peakSystemCpuPercent ?? 0) >= 90 || resources.minimumAvailableMemoryBytes < 1_073_741_824) {
        httpAbortedAt = concurrency
        break
      }
    }

    activePhase = "PostgreSQL persistence baseline"
    const persistenceSampler = startResources()
    const persistenceRoomId = String(fileA.roomId)
    const persistenceDoc = new Y.Doc()
    const persistenceText = persistenceDoc.getText("code")
    const persistenceTimes: number[] = []
    const persistenceRepetitions: Record<string, unknown>[] = []
    let persistenceErrors = 0
    const persistOne = async (measure: boolean) => {
      let update: Uint8Array | undefined
      const onUpdate = (value: Uint8Array) => { update = value }
      persistenceDoc.once("update", onUpdate)
      persistenceText.insert(persistenceText.length, "x")
      if (!update) throw new Error("Yjs did not produce a persistence benchmark update.")
      const encodedUpdate = new Uint8Array(update)
      const started = performance.now()
      try {
        await bounded(persistRoomUpdate(persistenceRoomId, encodedUpdate, persistenceText.toString()), maxRequestMs)
        if (measure) persistenceTimes.push(performance.now() - started)
      } catch {
        if (measure) persistenceErrors += 1
        else throw new Error("Database persistence warm-up failed.")
      }
    }
    for (let warmup = 0; warmup < 5; warmup += 1) await persistOne(false)
    const persistenceStarted = performance.now()
    for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
      const repetitionStarted = performance.now()
      const firstSample = persistenceTimes.length
      const errorsBefore = persistenceErrors
      for (let sample = 0; sample < options.requestsPerRepetition; sample += 1) await persistOne(true)
      const repetitionTimes = persistenceTimes.slice(firstSample)
      const repetitionErrors = persistenceErrors - errorsBefore
      const repetitionDuration = performance.now() - repetitionStarted
      persistenceRepetitions.push({
        repetition: repetition + 1,
        ...statsForTimes(repetitionTimes, repetitionErrors, repetitionDuration),
      })
    }
    const persistenceDurationMs = performance.now() - persistenceStarted
    persistenceDoc.destroy()
    const persistenceResources = persistenceSampler.stop()
    if (persistenceErrors) failures.push(`PostgreSQL persistence had ${persistenceErrors} failed transactions.`)

    activePhase = "WebSocket connection baseline"
    const socketStages: Record<string, unknown>[] = []
    let websocketAbortedAt: number | undefined
    for (const concurrency of routeStages(options.maxClients)) {
      const sampler = startResources()
      const openLatencies: number[] = []
      const authLatencies: number[] = []
      const joinLatencies: number[] = []
      const repetitionRows: Record<string, unknown>[] = []
      let successfulConnections = 0
      let failedConnections = 0
      let unexpectedDisconnects = 0
      let durationMs = 0
      for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
        const started = performance.now()
        const openBefore = openLatencies.length
        const authBefore = authLatencies.length
        const joinBefore = joinLatencies.length
        const successBefore = successfulConnections
        const failureBefore = failedConnections
        const results = await Promise.allSettled(Array.from({ length: concurrency }, async (_, index) => {
          const user = allUsers[index]!
          const result = await connectPeer(baseUrl!, user.token, user.id, String(fileA!.roomId))
          openPeers.add(result.peer)
          return result
        }))
        const repetitionDuration = performance.now() - started
        durationMs += repetitionDuration
        const connected = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof connectPeer>>> => result.status === "fulfilled")
        const rejected = results.length - connected.length
        failedConnections += rejected
        successfulConnections += connected.length
        unexpectedDisconnects += connected.filter(({ value }) => value.peer.closedUnexpectedly).length
        for (const result of connected) {
          openLatencies.push(result.value.connectionMs)
          authLatencies.push(result.value.authenticationMs)
          joinLatencies.push(result.value.joinMs ?? 0)
        }
        if (rejected) failures.push(`WebSocket stage concurrency ${concurrency} had ${rejected} failed connections.`)
        repetitionRows.push({
          repetition: repetition + 1,
          connectionEstablishment: latencySummary(openLatencies.slice(openBefore)),
          authentication: latencySummary(authLatencies.slice(authBefore)),
          roomJoin: latencySummary(joinLatencies.slice(joinBefore)),
          successfulConnections: successfulConnections - successBefore,
          failedConnections: failedConnections - failureBefore,
          durationMs: round(repetitionDuration),
          connectionsPerSecond: repetitionDuration > 0 ? round((successfulConnections - successBefore) / (repetitionDuration / 1000)) : 0,
        })
        await Promise.all(connected.map(({ value }) => closePeer(value.peer)))
        for (const { value } of connected) openPeers.delete(value.peer)
      }
      const resources = sampler.stop()
      socketStages.push({
        requestedConcurrency: concurrency,
        achievedConcurrency: Math.min(concurrency, successfulConnections),
        repetitions: repetitionRows,
        connectionEstablishment: latencySummary(openLatencies),
        authentication: latencySummary(authLatencies),
        roomJoin: latencySummary(joinLatencies),
        successfulConnections,
        failedConnections,
        unexpectedDisconnects,
        errorRate: successfulConnections + failedConnections ? round(failedConnections / (successfulConnections + failedConnections)) : 0,
        durationMs: round(durationMs),
        connectionsPerSecond: durationMs > 0 ? round(successfulConnections / (durationMs / 1000)) : 0,
        resourceObservations: resources,
      })
      const maxP95 = Math.max(0, percentile(openLatencies, 0.95) ?? 0, percentile(authLatencies, 0.95) ?? 0, percentile(joinLatencies, 0.95) ?? 0)
      if (failedConnections || unexpectedDisconnects || maxP95 > 1_000 || (resources.peakSystemCpuPercent ?? 0) >= 90 || resources.minimumAvailableMemoryBytes < 1_073_741_824) {
        websocketAbortedAt = concurrency
        break
      }
    }

    activePhase = "collaborative editing and convergence"
    const collaborationCount = Math.min(5, options.maxClients)
    const editPeers: BenchPeer[] = []
    const peerSetupLatencies = await Promise.all(Array.from({ length: collaborationCount }, async (_, index) => {
      const user = allUsers[index]!
      const connected = await connectPeer(baseUrl!, user.token, user.id, String(fileA!.roomId))
      editPeers.push(connected.peer)
      openPeers.add(connected.peer)
      return connected.totalSetupMs
    }))

    const collaborationSampler = startResources()
    let collaborativeUpdateFailures = 0
    const propagationLatencies: number[] = []
    const measuredUpdateCount = Math.max(1, Math.ceil(options.requestsPerRepetition / 10))
    let collaborationAborted = false
    const applyRound = async (measure: boolean) => {
      const updates = editPeers.map((peer, peerIndex) => {
        let update: Uint8Array | undefined
        const capture = (value: Uint8Array) => { update = value }
        peer.doc.once("update", capture)
        peer.doc.getText("code").insert(peer.doc.getText("code").length, `b${peerIndex}`)
        if (!update) throw new Error("Yjs did not produce a collaborative benchmark update.")
        return { peer, update: Buffer.from(update).toString("base64") }
      })
      const sendWaits = updates.map((item) => editPeers.filter((peer) => peer !== item.peer).map((peer) => ({ peer, waiter: waitForPeerUpdate(peer, item.update) })))
      const sendStartedAt = performance.now()
      for (let index = 0; index < updates.length; index += 1) {
        const waits = sendWaits[index]!
        const startedAt = performance.now()
        for (const { waiter } of waits) waiter.markSent(startedAt)
        updates[index]!.peer.ws.send(JSON.stringify({ type: "doc-update", roomId: String(fileA!.roomId), update: updates[index]!.update }))
      }
      const settled = await Promise.allSettled(sendWaits.flatMap((waits) => waits.map(({ waiter }) => waiter.wait)))
      const successful = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
      if (measure) propagationLatencies.push(...successful)
      const rejected = settled.length - successful.length
      collaborativeUpdateFailures += rejected
      if (rejected) {
        failures.push(`Collaborative update round missed ${rejected} peer deliveries; peer receive counts: ${editPeers.map((peer) => peer.receivedDocUpdates).join(",")}.`)
        collaborationAborted = true
      }
      const expected = editPeers[0]!.doc.getText("code").toString()
      const converged = editPeers.every((peer) => peer.doc.getText("code").toString() === expected)
      if (!converged) failures.push("Yjs clients did not converge after a collaborative update round.")
      return { converged, durationMs: performance.now() - sendStartedAt, peerDeliveryLatencies: successful, failedPeerDeliveries: rejected }
    }
    await applyRound(false)
    const collaborationStarted = performance.now()
    let collaborationRoundsCompleted = 0
    const collaborationRepetitions: Record<string, unknown>[] = []
    collaborationRuns: for (let repetition = 0; repetition < options.repetitions && !collaborationAborted; repetition += 1) {
      const firstSample = propagationLatencies.length
      const errorsBefore = collaborativeUpdateFailures
      const repetitionStarted = performance.now()
      let repetitionRounds = 0
      for (let roundIndex = 0; roundIndex < measuredUpdateCount; roundIndex += 1) {
        await applyRound(true)
        collaborationRoundsCompleted += 1
        repetitionRounds += 1
        if (collaborationAborted) break
      }
      const repetitionTimes = propagationLatencies.slice(firstSample)
      const repetitionErrors = collaborativeUpdateFailures - errorsBefore
      const repetitionDuration = performance.now() - repetitionStarted
      collaborationRepetitions.push({
        repetition: repetition + 1,
        updatesSent: repetitionRounds * collaborationCount,
        ...statsForTimes(repetitionTimes, repetitionErrors, repetitionDuration),
      })
      if (collaborationAborted) break collaborationRuns
    }
    const collaborationDurationMs = performance.now() - collaborationStarted
    const collaborationResources = collaborationSampler.stop()
    const persistedUpdateCount = await prisma.documentUpdate.count({ where: { roomId: String(fileA.roomId) } })
    const expectedPersistedUpdateCount = 1 + 5
      + (options.requestsPerRepetition * options.repetitions)
      + (collaborationRoundsCompleted + 1) * collaborationCount
    if (persistedUpdateCount < expectedPersistedUpdateCount) failures.push("The collaboration test did not persist the expected bounded update count.")

    activePhase = "project and file isolation check"
    const isolationPeerConnection = await connectPeer(baseUrl, allUsers[0]!.token, allUsers[0]!.id, String(fileB.roomId))
    openPeers.add(isolationPeerConnection.peer)
    const isolationPeer = isolationPeerConnection.peer
    const textBeforeIsolation = isolationPeer.doc.getText("code").toString()
    const isolatingSender = editPeers[0]!
    const isolationProbe = socketWait(isolationPeer, (message) => message.type === "doc-update", 1_000)
      .then(() => true, () => false)
    const isolationStarted = performance.now()
    const isolationUpdate = new Y.Doc()
    isolationUpdate.getText("code").insert(0, `isolated_${randomBytes(4).toString("hex")}`)
    const isolationBytes = Y.encodeStateAsUpdate(isolationUpdate)
    const isolationEncoded = Buffer.from(isolationBytes).toString("base64")
    const expectedIsolation = editPeers.slice(1).map((peer) => waitForPeerUpdate(peer, isolationEncoded))
    const isolationSendAt = performance.now()
    Y.applyUpdate(isolatingSender.doc, isolationBytes)
    for (const waiter of expectedIsolation) waiter.markSent(isolationSendAt)
    isolatingSender.ws.send(JSON.stringify({ type: "doc-update", roomId: String(fileA.roomId), update: isolationEncoded }))
    const isolationDelivery = await Promise.allSettled(expectedIsolation.map((waiter) => waiter.wait))
    if (await isolationProbe) {
      failures.push("An update crossed the project/file room boundary.")
    }
    const isolationCorrect = isolationDelivery.every((result) => result.status === "fulfilled")
      && isolationPeer.doc.getText("code").toString() === textBeforeIsolation
      && isolatingSender.roomId !== isolationPeer.roomId
    if (!isolationCorrect) failures.push("Separate project/file documents did not remain isolated.")
    isolationUpdate.destroy()
    const isolationDurationMs = round(performance.now() - isolationStarted)

    const presenceSampler = startResources()
    const presenceLatencies: number[] = []
    const presenceRepetitions: Record<string, unknown>[] = []
    let presenceFailures = 0
    const warmPresenceWait = socketWait(editPeers[1]!, (message) => message.type === "presence-update" && message.collaborator?.userId === editPeers[0]!.userId, messageTimeoutMs)
    editPeers[0]!.ws.send(JSON.stringify({ type: "presence-update", cursor: { line: 1, column: 1 } }))
    await warmPresenceWait
    await nextTurn(presenceIntervalMs)
    const presenceStarted = performance.now()
    presenceRuns: for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
      const firstSample = presenceLatencies.length
      const errorsBefore = presenceFailures
      const repetitionStarted = performance.now()
      let repetitionFailed = false
      for (let wave = 0; wave < presenceWaves; wave += 1) {
        const expects = editPeers.flatMap((sender, senderIndex) => editPeers.filter((peer) => peer !== sender).map((peer) => {
          const cursor = { line: 10 + repetition * presenceWaves + wave, column: senderIndex + 1 }
          return { sender, peer, cursor, waiter: waitForPresence(peer, sender.userId, cursor.line, cursor.column) }
        }))
        const waveStarted = performance.now()
        for (const { sender, peer, cursor, waiter } of expects) {
          if (sender === peer) continue
          waiter.markSent(waveStarted)
        }
        for (let senderIndex = 0; senderIndex < editPeers.length; senderIndex += 1) {
          const sender = editPeers[senderIndex]!
          const cursor = { line: 10 + repetition * presenceWaves + wave, column: senderIndex + 1 }
          sender.ws.send(JSON.stringify({ type: "presence-update", cursor }))
        }
        const settled = await Promise.allSettled(expects.map((item) => item.waiter.wait))
        const successful = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
        presenceLatencies.push(...successful)
        const missed = settled.length - successful.length
        presenceFailures += missed
        if (missed) {
          failures.push(`Presence wave ${wave + 1} missed ${missed} peer updates; remaining waves were skipped.`)
          repetitionFailed = true
          break
        }
        if (wave < presenceWaves - 1) await nextTurn(Math.max(0, presenceIntervalMs - (performance.now() - waveStarted)))
      }
      const repetitionTimes = presenceLatencies.slice(firstSample)
      const repetitionErrors = presenceFailures - errorsBefore
      const repetitionDuration = performance.now() - repetitionStarted
      presenceRepetitions.push({
        repetition: repetition + 1,
        ...statsForTimes(repetitionTimes, repetitionErrors, repetitionDuration),
      })
      if (repetitionFailed) break presenceRuns
    }
    const presenceDurationMs = performance.now() - presenceStarted
    const presenceResources = presenceSampler.stop()
    if (presenceFailures) failures.push(`Presence propagation missed ${presenceFailures} peer updates.`)

    activePhase = "authorization, disconnect cleanup, and post-load health checks"
    const outsiderHttp = await request(baseUrl, `/projects/${projectA.id}/files`, outsider.token)
    const anonymousHttp = await request(baseUrl, "/projects")
    let unauthorizedWebSocketDenied = false
    const outsiderPeerConnection = await connectPeer(baseUrl, outsider.token, outsider.id, String(fileA.roomId), false)
    openPeers.add(outsiderPeerConnection.peer)
    const unauthorizedJoin = socketWait(outsiderPeerConnection.peer, (message) => message.type === "error")
    outsiderPeerConnection.peer.ws.send(JSON.stringify({ type: "join", roomId: String(fileA.roomId), stateVector: "" }))
    try {
      await unauthorizedJoin
      unauthorizedWebSocketDenied = true
    } catch {
      unauthorizedWebSocketDenied = false
    }
    if (outsiderHttp.status !== 404 || anonymousHttp.status !== 401 || !unauthorizedWebSocketDenied) {
      failures.push("An unauthorized or unauthenticated request was not denied as expected.")
    }
    await closePeer(outsiderPeerConnection.peer)
    openPeers.delete(outsiderPeerConnection.peer)

    const presenceRemovalWait = socketWait(editPeers[1]!, (message) => message.type === "presence-remove" && message.userId === editPeers[0]!.userId)
    await closePeer(editPeers[0]!)
    openPeers.delete(editPeers[0]!)
    let presenceCleanupVerified = false
    try {
      await presenceRemovalWait
      presenceCleanupVerified = true
    } catch {
      failures.push("Presence was not removed from remaining peers after a disconnect.")
    }
    for (const peer of [...openPeers]) {
      await closePeer(peer)
      openPeers.delete(peer)
    }

    const postLoadHealth = await observeHealth(baseUrl)
    if (!postLoadHealth.healthy || !postLoadHealth.ready) failures.push("Server health/readiness did not recover after the benchmark.")
    const healthSamples: number[] = []
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now()
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(requestTimeoutMs(maxRequestMs)) })
      await response.arrayBuffer()
      if (response.status === 200) healthSamples.push(performance.now() - started)
    }

    report = {
      benchmark: "CodeSync local performance baseline",
      location: "local only; not a production capacity claim",
      generatedAt: new Date().toISOString(),
      environment: {
        os: `${os.type()} ${os.release()} (${os.arch()})`,
        node: process.version,
        postgresql: postgresVersion,
        database: databaseTarget.pathname.replace(/^\//, "").split("/")[0],
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCores: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      parameters: {
        maxClients: options.maxClients,
        concurrencyStages: routeStages(options.maxClients),
        requestsPerEndpointPerRepetition: options.requestsPerRepetition,
        repetitions: options.repetitions,
        warmupHttpRequestsPerEndpoint: 5,
        warmupWebSocketConnections: 1,
        warmupPersistenceTransactions: 5,
        presenceIntervalMs,
        presenceWavesPerRepetition: presenceWaves,
        yjsUpdatesPerClientPerRound: 1,
        yjsRoundsPerRepetition: measuredUpdateCount,
      },
      methodology: {
        clock: "performance.now() monotonic high-resolution clock",
        percentiles: "Nearest-rank sorted sample: value at ceil(p*n)-1; p95 omitted below 20 samples and p99 omitted below 100 samples.",
        repeatVariability: "Per-repetition records are retained in the HTTP section; the other scenarios aggregate their repeated latency samples.",
        collaborativeLatency: "Client WebSocket send to peer message receipt; includes server handling, ordered PostgreSQL persistence, and broadcast. It is not server-only processing time.",
        databaseLatency: "Duration of the existing persistRoomUpdate PostgreSQL transaction called directly by the harness; separate from HTTP and WebSocket measurements.",
        resourceObservations: "System-wide peak CPU and minimum available memory are sampled every 250ms; benchmark-process RSS excludes the spawned server and PostgreSQL.",
        safety: "The server binds to loopback. No database reset, public service, or Judge0 request is performed. Only temporary benchmark users/projects/files are created and then removed. The full run is capped at three minutes, each HTTP/DB operation at 10 seconds, and each WebSocket event wait at eight seconds.",
      migrations: "The script applies checked-in Prisma migrations to the validated codesync_test database before creating fixtures; it never resets the database.",
        stopThresholds: "Do not increase a load stage after a failed operation, p95 above 1000ms, sampled system CPU at or above 90%, or available memory below 1GiB.",
      },
      setup: { durationMs: setupDurationMs, resourceObservations: setupResources },
      http: { stages: httpResults, abortedBeforeConcurrency: httpAbortedAt ?? null },
      websocketConnections: { stages: socketStages, abortedBeforeConcurrency: websocketAbortedAt ?? null },
      persistence: {
        operation: "persistRoomUpdate transaction",
        warmupTransactions: 5,
        ...statsForTimes(persistenceTimes, persistenceErrors, persistenceDurationMs),
        repetitions: persistenceRepetitions,
        resourceObservations: persistenceResources,
      },
      collaboration: {
        requestedConcurrency: collaborationCount,
        achievedConcurrency: editPeers.length,
        connectionSetup: latencySummary(peerSetupLatencies),
        measuredRounds: collaborationRoundsCompleted,
        updateMessagesSent: collaborationRoundsCompleted * collaborationCount,
        peerDeliverySamples: propagationLatencies.length,
        peerReceiveCounts: editPeers.map((peer) => peer.receivedDocUpdates),
        peerProtocolErrorCounts: editPeers.map((peer) => peer.protocolErrors),
        ...statsForTimes(propagationLatencies, collaborativeUpdateFailures, collaborationDurationMs),
        repetitions: collaborationRepetitions,
        convergenceVerified: editPeers.every((peer) => peer.doc.getText("code").toString() === editPeers[0]!.doc.getText("code").toString()),
        persistedUpdateCount,
        expectedPersistedUpdateCount,
        isolationAcrossProjectsAndFilesVerified: isolationCorrect,
        isolationProbeDurationMs: isolationDurationMs,
        resourceObservations: collaborationResources,
      },
      presence: {
        requestedConcurrency: editPeers.length,
      achievedConcurrency: editPeers.length,
        updateIntervalMs: presenceIntervalMs,
        sendsPerClientPerRepetition: presenceWaves,
        successfulPeerDeliveries: presenceLatencies.length,
        failedPeerDeliveries: presenceFailures,
        errorRate: presenceLatencies.length + presenceFailures ? round(presenceFailures / (presenceLatencies.length + presenceFailures)) : 0,
        durationMs: round(presenceDurationMs),
        throughputPerSecond: presenceDurationMs > 0 ? round(presenceLatencies.length / (presenceDurationMs / 1000)) : 0,
        ...latencySummary(presenceLatencies),
        repetitions: presenceRepetitions,
        resourceObservations: presenceResources,
      },
      correctness: {
        unauthenticatedHttpDenied: anonymousHttp.status === 401,
        unauthorizedProjectFileHttpDenied: outsiderHttp.status === 404,
        unauthorizedProjectWebSocketJoinDenied: unauthorizedWebSocketDenied,
        presenceRemovalAfterDisconnectVerified: presenceCleanupVerified,
        postLoadHealth: { ...postLoadHealth, fiveHealthRequestSamples: healthSamples.length, ...latencySummary(healthSamples) },
      },
      failures,
      safeServerEventCounts,
      passed: failures.length === 0,
    }
  } finally {
    for (const peer of [...openPeers]) await closePeer(peer).catch(() => undefined)
    if (child) {
      try {
        await stopServer(child)
      } catch {
        failures.push("Could not confirm clean shutdown of the local benchmark server.")
      }
    }
    if (fixtureUserIds.length) {
      try {
        const deleted = await prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } })
        if (deleted.count !== fixtureUserIds.length) failures.push("Benchmark cleanup did not remove every temporary user record.")
        const roomIds = [fileA?.roomId, fileB?.roomId].filter((roomId): roomId is string => typeof roomId === "string")
        if (roomIds.length) {
          const remainingUpdates = await prisma.documentUpdate.count({ where: { roomId: { in: roomIds } } })
          if (remainingUpdates !== 0) failures.push("Benchmark cleanup left persisted document-update rows.")
        }
      } catch {
        failures.push("Could not confirm cleanup of temporary benchmark records.")
      }
    }
    await prisma.$disconnect().catch(() => failures.push("Could not confirm Prisma shutdown after benchmark cleanup."))
  }

  if (report) {
    ;(report as { failures: string[] }).failures = failures
    ;(report as { passed: boolean }).passed = failures.length === 0
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (failures.length) process.exitCode = 1
    return
  }
}

const options = (() => {
  try {
    const parsed = parseBenchmarkOptions(process.argv.slice(2))
    assertSafeBenchmarkTarget(process.env.DATABASE_URL, parsed.allowLocalTarget)
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid benchmark configuration."
    process.stderr.write(`CodeSync benchmark refused to run: ${message}\n`)
    process.exitCode = 1
    return undefined
  }
})()

if (options) {
  void main(options).catch(() => {
    process.stderr.write(`CodeSync benchmark failed during ${activePhase}; details are omitted to protect local configuration.\n`)
    process.exitCode = 1
  })
}
