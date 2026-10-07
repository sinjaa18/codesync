import { useEffect, useRef, useState } from "react"
import CodeEditor from "./components/CodeEditor"

const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:5000"
const wsUrl = import.meta.env.VITE_WS_URL || apiUrl.replace(/^http/, "ws")
type ConnectionStatus = "disconnected" | "connecting" | "connected"
type ServerMessage = {
  type: string
  message?: string
  roomId?: string
  code?: string
  count?: number
  userId?: string
  changes?: string
  line?: number
  column?: number
}

export default function App() {
  const [roomId, setRoomId] = useState("")
  const [joined, setJoined] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>("disconnected")
  const [error, setError] = useState("")
  const [output, setOutput] = useState("")
  const [language, setLanguage] = useState("javascript")
  const [code, setCode] = useState("console.log('Hello from CodeSync')")
  const [remoteCursor, setRemoteCursor] = useState<{ line: number; column: number } | null>(null)
  const [userCount, setUserCount] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userIdRef = useRef(crypto.randomUUID())
  const lastRemoteCodeRef = useRef<string | null>(null)
  const lastCursorRef = useRef("")
  const remoteCursorUserRef = useRef<string | null>(null)

  const connect = (targetRoom = roomId) => {
    const normalizedRoom = targetRoom.trim()
    if (!normalizedRoom || normalizedRoom.length > 64) {
      setError("Enter a room ID between 1 and 64 characters.")
      return
    }
    wsRef.current?.close()
    setError("")
    setStatus("connecting")
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", roomId: normalizedRoom, userId: userIdRef.current }))
    ws.onmessage = (event: MessageEvent<string>) => {
      let data: ServerMessage
      try {
        data = JSON.parse(event.data) as ServerMessage
      } catch {
        setError("The server sent an invalid response.")
        return
      }
      if (data.type === "error") {
        setError(data.message || "The server rejected the request.")
        setStatus("disconnected")
        ws.close()
        return
      }
      if (data.type === "joined") {
        setRoomId(normalizedRoom)
        setCode(data.code ?? "")
        lastRemoteCodeRef.current = data.code ?? ""
        setUserCount(data.count ?? 1)
        setStatus("connected")
        setJoined(true)
        setRemoteCursor(null)
        lastCursorRef.current = ""
        remoteCursorUserRef.current = null
        return
      }
      if (data.type === "users") setUserCount(data.count ?? 0)
      if (data.type === "user-left" && data.userId === remoteCursorUserRef.current) {
        setRemoteCursor(null)
        remoteCursorUserRef.current = null
      }
      if (data.type === "code-update" && typeof data.changes === "string") {
        lastRemoteCodeRef.current = data.changes
        setCode(data.changes)
      }
      if (data.type === "cursor-update" && Number.isInteger(data.line) && Number.isInteger(data.column)) {
        setRemoteCursor({ line: data.line!, column: data.column! })
        remoteCursorUserRef.current = data.userId ?? null
      }
    }
    ws.onerror = () => setError("Could not connect to the collaboration server.")
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      setStatus("disconnected")
      setUserCount(0)
      setRemoteCursor(null)
      setError((current) => current || "Connection closed. Reconnect to continue collaborating.")
    }
  }

  useEffect(() => {
    if (!joined || status !== "connected" || code === lastRemoteCodeRef.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    const room = roomId
    const content = code
    timerRef.current = setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "code-update", roomId: room, userId: userIdRef.current, changes: content }))
        lastRemoteCodeRef.current = content
      }
    }, 300)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [code, joined, roomId, status])

  const updateCursor = (line: number, column: number) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    const position = `${line}:${column}`
    if (position === lastCursorRef.current) return
    lastCursorRef.current = position
    wsRef.current.send(JSON.stringify({ type: "cursor-update", roomId, userId: userIdRef.current, line, column }))
  }

  const leaveRoom = () => {
    wsRef.current?.close()
    wsRef.current = null
    if (timerRef.current) clearTimeout(timerRef.current)
    setJoined(false)
    setStatus("disconnected")
    setUserCount(0)
    setCode("")
    setOutput("")
    setRemoteCursor(null)
    remoteCursorUserRef.current = null
    setError("")
    lastRemoteCodeRef.current = null
  }

  const runCode = async () => {
    setOutput("Running…")
    setError("")
    try {
      const response = await fetch(`${apiUrl}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, language }),
      })
      const raw: unknown = await response.json()
      if (!raw || typeof raw !== "object") throw new Error("The server sent an invalid response.")
      const data = raw as { stdout?: unknown; stderr?: unknown; error?: unknown; executionTimeMs?: unknown; success?: unknown }
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Execution failed (HTTP ${response.status}).`)
      if (typeof data.stdout !== "string" || typeof data.stderr !== "string") throw new Error("The server sent an invalid execution response.")
      setOutput([data.stdout, data.stderr].filter(Boolean).join("\n") || "Program finished with no output.")
      if (data.success === false) setError("Execution failed. See the output for details.")
      if (typeof data.executionTimeMs === "number") setOutput((value) => `${value}\n\nFinished in ${data.executionTimeMs} ms`)
    } catch (err) {
      setOutput("")
      setError(err instanceof Error ? err.message : "Execution failed.")
    }
  }

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      setError("Room ID copied.")
    } catch {
      setError("Could not copy the room ID. Copy it manually.")
    }
  }

  if (!joined) {
    return <main className="join-screen">
      <form className="join-box" onSubmit={(event) => { event.preventDefault(); connect() }}>
        <div className="logo"><span>Code</span><strong>Sync</strong></div>
        <p className="tagline">A shared space to write code together.</p>
        <label htmlFor="room-id">Room ID</label>
        <input id="room-id" autoComplete="off" maxLength={64} placeholder="Enter a room ID" value={roomId} onChange={(event) => setRoomId(event.target.value)} />
        <button type="submit" disabled={status === "connecting"}>{status === "connecting" ? "Connecting…" : "Join room"}</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </main>
  }

  return <main className="app">
    <header className="topbar">
      <div className="logo"><span>Code</span><strong>Sync</strong></div>
      <div className="room-details"><span>Room</span><code>{roomId}</code><button className="secondary" onClick={copyRoomId}>Copy ID</button></div>
      <div className="toolbar">
        <span className={`connection ${status}`}><i />{status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected"}</span>
        <span className="user-count">{userCount} {userCount === 1 ? "person" : "people"}</span>
        <select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option value="javascript">JavaScript</option><option value="typescript">TypeScript</option><option value="cpp">C++</option><option value="python">Python</option><option value="java">Java</option>
        </select>
        <button onClick={runCode}>Run</button>
        {status === "disconnected" && <button className="secondary" onClick={() => connect()}>Reconnect</button>}
        <button className="secondary" onClick={leaveRoom}>Leave</button>
      </div>
    </header>
    {error && <div className="notice" role="status">{error}<button aria-label="Dismiss" onClick={() => setError("")}>×</button></div>}
    <section className="workspace">
      <div className="editor-container"><CodeEditor value={code} language={language} remoteCursor={remoteCursor} onChange={setCode} onCursorMove={updateCursor} /></div>
      <aside className="output-container"><div className="output-title">Output</div><pre>{output || "Run your code to see output here."}</pre></aside>
    </section>
  </main>
}
