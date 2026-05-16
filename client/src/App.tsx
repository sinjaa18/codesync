import CodeEditor from "./components/CodeEditor"
import { useRef,useState } from "react"

export default function App(){

  const [roomId, setRoomId]=useState("")
  const [joined,setJoined]=useState(false)

  const [output,setOutput]=useState("")
  const [language,setLanguage]=useState("javascript")
  const [code,setCode]=useState("")
  const [remoteCursor,setRemoteCursor]=useState<{line:number,column:number}|null>(null)

  const wsRef = useRef<WebSocket|null>(null)
  const timeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isRemoteUpdate=useRef(false)

  const userIdRef = useRef(
    `user-${Math.floor(Math.random()*1000)}`
  )

  const joinRoom=()=>{
  if(!roomId.trim())return
  const ws = new WebSocket("wss://codesync-qngs.onrender.com/")
  wsRef.current=ws
  ws.onopen=()=>{
    ws.send(JSON.stringify({
      type:"join",
      roomId,
      userId:userIdRef.current
    }))

    setJoined(true)
  }
  ws.onmessage=(event)=>{
    const data = JSON.parse(event.data)
    if(data.userId===userIdRef.current)return
    if(data.type==="code-update"){
      isRemoteUpdate.current=true
      setCode(data.changes)
      setTimeout(()=>{
        isRemoteUpdate.current=false
      },0)
    }

    if(data.type==="cursor-update"){
      setRemoteCursor({
        line:data.line,
        column:data.column
      })
    }
  }
}

//run code button
  const runCode=async()=>{
    try{
      const res = await fetch("https://codesync-qngs.onrender.com/run",{
        method:"POST",
        headers:{
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          code,
          language
        })
      })

      const data = await res.json()
      setOutput(data.stdout || data.stderr)

    }catch(err){
      console.log(err)
      setOutput("Execution failed")
    }
  }

  //leave room button function
  const leaveRoom=()=>{
    wsRef.current?.close()
    setJoined(false)
    setCode("")
    setOutput("")
    setRemoteCursor(null)
  }

  if(!joined){
    return (
        <div className="join-screen">
            <div className="join-box">
                <div className="logo">
                    <span className="logo-code">Code</span>
                    <span className="logo-sync">Sync</span>
                </div>
                <input
                type="text"
                placeholder="Enter Room ID"
                value={roomId}
                onChange={(e)=>setRoomId(e.target.value)}
                />
                <button onClick={joinRoom}>Join Room</button>
            </div>
        </div>
    )
  }

  return(
    <div className="app">

      <div className="topbar">
        <div className="logo">
            <span className="logo-code">Code</span>
            <span className="logo-sync">Sync</span>
        </div>
        <div className="room">
          Room: {roomId}
        </div>

        <select
          value={language}
          onChange={(e)=>setLanguage(e.target.value)}
        >
          <option value="javascript">JavaScript</option>
          <option value="typescript">TypeScript</option>
          <option value="cpp">C++</option>
          <option value="python">Python</option>
          <option value="java">Java</option>
        </select>

        <button onClick={runCode}>
          Run
        </button>
        <button onClick={leaveRoom} className="leave-btn">
          Leave
        </button>
        <div className="status">
          Connected
        </div>

      </div>

      <div className="main-container">

        <div className="editor-container">

          <CodeEditor
            value={code}
            language={language}
            remoteCursor={remoteCursor}

            onChange={(val)=>{

              if(val===undefined)return
              if(isRemoteUpdate.current)return
              if(val===code)return

              setCode(val)

              if(timeRef.current){
                clearTimeout(timeRef.current)
              }

              timeRef.current=setTimeout(()=>{

                if(wsRef.current?.readyState!==WebSocket.OPEN)return

                wsRef.current.send(JSON.stringify({
                  type:"code-update",
                  changes:val,
                  roomId:{roomId},
                  userId:userIdRef.current
                }))

              },300)
            }}

            onCursorMove={(line,col)=>{

              if(wsRef.current?.readyState!==WebSocket.OPEN)return

              wsRef.current.send(JSON.stringify({
                type:"cursor-update",
                line,
                column:col,
                roomId:{roomId},
                userId:userIdRef.current
              }))
            }}
          />

        </div>

        <div className="output-container">

          <div className="output-title">
            Output
          </div>

          <pre>{output}</pre>

        </div>

      </div>

    </div>
  )
}