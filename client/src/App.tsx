import { useEffect, useRef, useState, type FormEvent } from "react"
import * as Y from "yjs"
import CodeEditor from "./components/CodeEditor"

const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:5000"
const wsUrl = import.meta.env.VITE_WS_URL || apiUrl.replace(/^http/, "ws")
const remoteOrigin = {}
type ConnectionStatus = "disconnected" | "connecting" | "connected"
type ServerMessage = {
  type: string
  message?: string
  roomId?: string
  update?: string
  stateVector?: string
  count?: number
  userId?: string
  line?: number
  column?: number
  user?: { id: string; username: string }
}
type AuthResponse = { token: string; user: { id: string; username: string }; error?: string }

function encodeBase64(bytes: Uint8Array) {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary)
}

function decodeBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export default function App() {
  const [token, setToken] = useState("")
  const [username, setUsername] = useState("")
  const [authMode, setAuthMode] = useState<"login" | "signup">("login")
  const [authUsername, setAuthUsername] = useState("")
  const [authPassword, setAuthPassword] = useState("")
  const [roomId, setRoomId] = useState("")
  const [inviteUsername, setInviteUsername] = useState("")
  const [joined, setJoined] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>("disconnected")
  const [error, setError] = useState("")
  const [output, setOutput] = useState("")
  const [language, setLanguage] = useState("javascript")
  const [doc, setDoc] = useState(() => new Y.Doc())
  const [remoteCursor, setRemoteCursor] = useState<{ line: number; column: number } | null>(null)
  const [userCount, setUserCount] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const docRef = useRef(doc)
  const activeRoomRef = useRef<string | null>(null)
  const lastCursorRef = useRef("")
  const remoteCursorUserRef = useRef<string | null>(null)

  useEffect(() => {
    const sendUpdate = (update: Uint8Array, origin: unknown) => {
      const ws = wsRef.current
      const activeRoom = activeRoomRef.current
      if (origin === remoteOrigin || !activeRoom || ws?.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({
        type: "doc-update",
        roomId: activeRoom,
        update: encodeBase64(update),
      }))
    }
    doc.on("update", sendUpdate)
    return () => {
      doc.off("update", sendUpdate)
      doc.destroy()
    }
  }, [doc])

  const authenticate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError("")
    try {
      const response = await fetch(`${apiUrl}/auth/${authMode === "signup" ? "signup" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authUsername, password: authPassword }),
      })
      const data = await response.json() as AuthResponse
      if (!response.ok) throw new Error(data.error || "Authentication failed.")
      setToken(data.token)
      setUsername(data.user.username)
      setAuthPassword("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.")
    }
  }

  const connect = async (targetRoom = roomId) => {
    const normalizedRoom = targetRoom.trim()
    if (!normalizedRoom || normalizedRoom.length > 64) {
      setError("Enter a room ID between 1 and 64 characters.")
      return
    }
    wsRef.current?.close()
    setError("")
    setStatus("connecting")
    try {
      const access = await fetch(`${apiUrl}/rooms/${encodeURIComponent(normalizedRoom)}/access`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
      const accessData = await access.json() as { error?: string }
      if (!access.ok) throw new Error(accessData.error || `Could not access room (HTTP ${access.status}).`)
    } catch (err) {
      setStatus("disconnected")
      setError(err instanceof Error ? err.message : "Could not access room.")
      return
    }
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: "authenticate", token }))
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
      if (data.type === "authenticated") {
        ws.send(JSON.stringify({
          type: "join",
          roomId: normalizedRoom,
          stateVector: encodeBase64(Y.encodeStateVector(docRef.current)),
        }))
      }
      if (data.type === "joined") {
        try {
          const currentDoc = docRef.current
          Y.applyUpdate(currentDoc, decodeBase64(data.update ?? ""), remoteOrigin)
          const missing = Y.encodeStateAsUpdate(currentDoc, decodeBase64(data.stateVector ?? ""))
          if (missing.length > 2 && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "doc-update",
              roomId: normalizedRoom,
              update: encodeBase64(missing),
            }))
          }
        } catch {
          setError("The server sent an invalid collaboration state.")
          setStatus("disconnected")
          ws.close()
          return
        }
        activeRoomRef.current = normalizedRoom
        setRoomId(normalizedRoom)
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
      if (data.type === "code-update") {
        setError("The server is using an outdated collaboration protocol. Refresh the application.")
        ws.close()
      }
      if (data.type === "doc-update" && typeof data.update === "string") {
        try {
          Y.applyUpdate(docRef.current, decodeBase64(data.update), remoteOrigin)
        } catch {
          setError("The server sent an invalid document update.")
        }
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
      activeRoomRef.current = null
      setRemoteCursor(null)
      setError((current) => current || "Connection closed. Reconnect to continue collaborating.")
    }
  }

  const updateCursor = (line: number, column: number) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    const position = `${line}:${column}`
    if (position === lastCursorRef.current) return
    lastCursorRef.current = position
    wsRef.current.send(JSON.stringify({ type: "cursor-update", roomId, line, column }))
  }

  const leaveRoom = () => {
    wsRef.current?.close()
    wsRef.current = null
    activeRoomRef.current = null
    const emptyDoc = new Y.Doc()
    docRef.current = emptyDoc
    setDoc(emptyDoc)
    setJoined(false)
    setStatus("disconnected")
    setUserCount(0)
    setOutput("")
    setRemoteCursor(null)
    remoteCursorUserRef.current = null
    setError("")
  }

  const inviteMember = async () => {
    try {
      const response = await fetch(`${apiUrl}/rooms/${encodeURIComponent(roomId)}/invites`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ username: inviteUsername }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(data.error || `Invite failed (HTTP ${response.status}).`)
      setError(`${inviteUsername} can now join ${roomId}.`)
      setInviteUsername("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite failed.")
    }
  }

  const logout = async () => {
    wsRef.current?.close()
    leaveRoom()
    try {
      await fetch(`${apiUrl}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
    } catch {
      setError("Could not reach the server to revoke this session. The local session was cleared; server-side expiry is one hour.")
    } finally {
      setToken("")
      setUsername("")
    }
  }

  const runCode = async () => {
    setOutput("Running…")
    setError("")
    try {
      const response = await fetch(`${apiUrl}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: docRef.current.getText("code").toString(), language }),
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

  if (!token) {
    return <main className="join-screen">
      <form className="join-box" onSubmit={authenticate}>
        <div className="logo"><span>Code</span><strong>Sync</strong></div>
        <p className="tagline">{authMode === "signup" ? "Create an account to collaborate." : "Sign in to your CodeSync account."}</p>
        <label htmlFor="auth-username">Username</label>
        <input id="auth-username" autoComplete="username" minLength={3} maxLength={24} required value={authUsername} onChange={(event) => setAuthUsername(event.target.value)} />
        <label htmlFor="auth-password">Password</label>
        <input id="auth-password" type="password" autoComplete={authMode === "signup" ? "new-password" : "current-password"} minLength={10} maxLength={128} required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} />
        <button type="submit">{authMode === "signup" ? "Create account" : "Sign in"}</button>
        <button type="button" className="secondary" onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setError("") }}>{authMode === "signup" ? "I already have an account" : "Create an account"}</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </main>
  }

  if (!joined) {
    return <main className="join-screen">
      <form className="join-box" onSubmit={(event) => { event.preventDefault(); connect() }}>
        <div className="logo"><span>Code</span><strong>Sync</strong></div>
        <p className="tagline">A shared space to write code together.</p>
        <p className="tagline">Signed in as <strong>{username}</strong></p>
        <label htmlFor="room-id">Room ID</label>
        <input id="room-id" autoComplete="off" maxLength={64} placeholder="Enter a room ID" value={roomId} onChange={(event) => setRoomId(event.target.value)} />
        <button type="submit" disabled={status === "connecting"}>{status === "connecting" ? "Connecting…" : "Join room"}</button>
        <button type="button" className="secondary" onClick={logout}>Sign out</button>
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
        <input aria-label="Invite username" placeholder="Invite username" value={inviteUsername} onChange={(event) => setInviteUsername(event.target.value)} />
        <button className="secondary" disabled={!inviteUsername.trim()} onClick={inviteMember}>Invite</button>
        <select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option value="javascript">JavaScript</option><option value="typescript">TypeScript</option><option value="cpp">C++</option><option value="python">Python</option><option value="java">Java</option>
        </select>
        <button onClick={runCode}>Run</button>
        {status === "disconnected" && <button className="secondary" onClick={() => connect()}>Reconnect</button>}
        <button className="secondary" onClick={leaveRoom}>Leave</button>
        <button className="secondary" onClick={logout}>Sign out</button>
      </div>
    </header>
    {error && <div className="notice" role="status">{error}<button aria-label="Dismiss" onClick={() => setError("")}>×</button></div>}
    <section className="workspace">
      <div className="editor-container"><CodeEditor doc={doc} language={language} remoteCursor={remoteCursor} onCursorMove={updateCursor} /></div>
      <aside className="output-container"><div className="output-title">Output</div><pre>{output || "Run your code to see output here."}</pre></aside>
    </section>
  </main>
}
