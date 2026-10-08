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
type Project = { id: string; name: string; role: string }
type WorkspaceFile = { id: string; projectId: string; path: string; content: string; roomId: string | null }

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
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [activeFile, setActiveFile] = useState<WorkspaceFile | null>(null)
  const [projectName, setProjectName] = useState("")
  const wsRef = useRef<WebSocket | null>(null)
  const docRef = useRef(doc)
  const activeRoomRef = useRef<string | null>(null)
  const lastCursorRef = useRef("")
  const remoteCursorUserRef = useRef<string | null>(null)

  useEffect(() => {
    if (!token) return
    fetch(`${apiUrl}/projects`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const data = await response.json() as Project[] | { error?: string }
        if (!response.ok || !Array.isArray(data)) throw new Error("Could not load projects.")
        setProjects(data)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load projects."))
  }, [token])

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

  const loadProject = async (selected: Project) => {
    setError("")
    try {
      const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(selected.id)}/files`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json() as WorkspaceFile[] | { error?: string }
      if (!response.ok || !Array.isArray(data)) throw new Error("Could not load project files.")
      wsRef.current?.close()
      setJoined(false)
      setProject(selected)
      setFiles(data)
      setActiveFile(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load project files.")
    }
  }

  const createProjectFromForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError("")
    try {
      const response = await fetch(`${apiUrl}/projects`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName }),
      })
      const created = await response.json() as Project & { error?: string }
      if (!response.ok) throw new Error(created.error || "Could not create project.")
      const fileResponse = await fetch(`${apiUrl}/projects/${encodeURIComponent(created.id)}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "main.js" }),
      })
      if (!fileResponse.ok) throw new Error("Project created, but its starter file could not be created.")
      const starter = await fileResponse.json() as WorkspaceFile
      const nextProject = { ...created, role: "OWNER" }
      setProjects((items) => [nextProject, ...items])
      setProjectName("")
      setProject(nextProject)
      setFiles([starter])
      setActiveFile(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project.")
    }
  }

  const createFile = async () => {
    if (!project) return
    const path = window.prompt("File path", "src/index.js")
    if (!path) return
    try {
      const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(project.id)}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      })
      const data = await response.json() as WorkspaceFile & { error?: string }
      if (!response.ok) throw new Error(data.error || "Could not create file.")
      setFiles((items) => [...items, data].sort((a, b) => a.path.localeCompare(b.path)))
      openFile(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create file.")
    }
  }

  const renameFile = async (file: WorkspaceFile) => {
    if (!project) return
    const path = window.prompt("Rename file", file.path)
    if (!path || path === file.path) return
    try {
      const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(file.id)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      })
      const data = await response.json() as WorkspaceFile & { error?: string }
      if (!response.ok) throw new Error(data.error || "Could not rename file.")
      setFiles((items) => items.map((item) => item.id === file.id ? data : item).sort((a, b) => a.path.localeCompare(b.path)))
      if (activeFile?.id === file.id) setActiveFile(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename file.")
    }
  }

  const deleteFile = async (file: WorkspaceFile) => {
    if (!project || !window.confirm(`Delete ${file.path}?`)) return
    try {
      const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(file.id)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error("Could not delete file.")
      setFiles((items) => items.filter((item) => item.id !== file.id))
      if (activeFile?.id === file.id) leaveRoom()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete file.")
    }
  }

  const openFile = (file: WorkspaceFile) => {
    if (!file.roomId) {
      setError("This file has no collaboration document yet. Create a new file to edit it together.")
      return
    }
    const emptyDoc = new Y.Doc()
    docRef.current = emptyDoc
    setDoc(emptyDoc)
    setActiveFile(file)
    const extension = file.path.split(".").pop()?.toLowerCase()
    const languageByExtension: Record<string, string> = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", cpp: "cpp", cc: "cpp", java: "java" }
    setLanguage(languageByExtension[extension ?? ""] ?? "javascript")
    connect(file.roomId)
  }

  const connect = async (targetRoom = roomId) => {
    const normalizedRoom = targetRoom.trim()
    if (!normalizedRoom || normalizedRoom.length > 64) {
      setError("Enter a room ID between 1 and 64 characters.")
      return
    }
    const previousSocket = wsRef.current
    wsRef.current = null
    activeRoomRef.current = null
    previousSocket?.close()
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
    setActiveFile(null)
    setError("")
  }

  const inviteMember = async () => {
    try {
      const inviteUrl = project
        ? `${apiUrl}/projects/${encodeURIComponent(project.id)}/invites`
        : `${apiUrl}/rooms/${encodeURIComponent(roomId)}/invites`
      const response = await fetch(inviteUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ username: inviteUsername }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(data.error || `Invite failed (HTTP ${response.status}).`)
      setError(`${inviteUsername} can now access ${project?.name ?? roomId}.`)
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
      setProjects([])
      setProject(null)
      setFiles([])
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
      <section className="project-home">
        <div className="logo"><span>Code</span><strong>Sync</strong></div>
        <div className="project-heading"><div><h1>{project?.name ?? "Your projects"}</h1><p className="tagline">Signed in as <strong>{username}</strong></p></div>
          {project && <button className="secondary" onClick={() => setProject(null)}>All projects</button>}
          <button className="secondary" onClick={logout}>Sign out</button>
        </div>
        {!project ? <>
          <form className="create-project" onSubmit={createProjectFromForm}>
            <input aria-label="Project name" placeholder="New project name" maxLength={80} required value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            <button type="submit">Create project</button>
          </form>
          <div className="project-list" aria-label="Projects">
            {projects.map((item) => <button className="project-card" key={item.id} onClick={() => loadProject(item)}><strong>{item.name}</strong><span>{item.role.toLowerCase()}</span></button>)}
            {!projects.length && <p className="tagline">No projects yet. Create one to start a multi-file workspace.</p>}
          </div>
          <details className="legacy-room"><summary>Join an existing room</summary>
            <form className="create-project" onSubmit={(event) => { event.preventDefault(); setProject(null); connect() }}>
              <input aria-label="Room ID" autoComplete="off" maxLength={64} placeholder="Enter a room ID" value={roomId} onChange={(event) => setRoomId(event.target.value)} />
              <button type="submit" disabled={status === "connecting"}>{status === "connecting" ? "Connecting…" : "Join room"}</button>
            </form>
          </details>
        </> : <>
          <div className="file-heading"><h2>Files</h2><button onClick={createFile}>New file</button></div>
          <ul className="project-files">
            {files.map((file) => <li key={file.id}>
              <button className={`file-open${activeFile?.id === file.id ? " selected" : ""}`} onClick={() => openFile(file)}>{file.path}</button>
              <button className="file-action" aria-label={`Rename ${file.path}`} title="Rename" onClick={() => renameFile(file)}>✎</button>
              <button className="file-action" aria-label={`Delete ${file.path}`} title="Delete" onClick={() => deleteFile(file)}>×</button>
            </li>)}
            {!files.length && <li className="tagline">This project has no files.</li>}
          </ul>
          {activeFile && <button className="open-workspace" onClick={() => openFile(activeFile)}>Open {activeFile.path}</button>}
        </>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </main>
  }

  return <main className="app">
    <header className="topbar">
      <div className="logo"><span>Code</span><strong>Sync</strong></div>
      <div className="room-details"><span>{project?.name ?? "Room"}</span><code>{activeFile?.path ?? roomId}</code>{!project && <button className="secondary" onClick={copyRoomId}>Copy ID</button>}</div>
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
      {project && <aside className="file-explorer"><div className="explorer-heading"><span>EXPLORER</span><button title="New file" aria-label="New file" onClick={createFile}>+</button></div><div className="explorer-project">{project.name}</div>
        {files.map((file) => <div className={`explorer-file${activeFile?.id === file.id ? " selected" : ""}`} key={file.id} style={{ paddingLeft: `${8 + Math.max(0, file.path.split("/").length - 1) * 12}px` }}><button title={file.path} onClick={() => openFile(file)}>{file.path.split("/").at(-1)}</button><span><button aria-label={`Rename ${file.path}`} title="Rename" onClick={() => renameFile(file)}>✎</button><button aria-label={`Delete ${file.path}`} title="Delete" onClick={() => deleteFile(file)}>×</button></span></div>)}
      </aside>}
      <div className="editor-container"><CodeEditor doc={doc} language={language} remoteCursor={remoteCursor} onCursorMove={updateCursor} /></div>
      <aside className="output-container"><div className="output-title">Output</div><pre>{output || "Run your code to see output here."}</pre></aside>
    </section>
  </main>
}
