import express from "express"
import cors from "cors"
import { createServer } from "node:http"
import { WebSocketServer,WebSocket,type RawData } from "ws"

import executionRoutes from "./routes/execution.route.js"
import type { WSMessage } from "./types/ws.types.js"

const app = express()
const PORT = 5000

const server = createServer(app)

const wss = new WebSocketServer({ server })

const rooms = new Map<string,Set<WebSocket>>()
const clientRoom = new Map<WebSocket,string>()
const roomCode = new Map<string,string>()

wss.on("connection",(ws:WebSocket)=>{

  console.log("Client connected")

  ws.on("message",(data:RawData)=>{

    const text = data.toString()

    let parsed:WSMessage

    try{
      parsed = JSON.parse(text)
    }catch{
      console.log("Invalid JSON")
      return
    }

    if(parsed.type==="join"){

      const { roomId } = parsed

      if(!rooms.has(roomId)){
        rooms.set(roomId,new Set())
      }

      rooms.get(roomId)?.add(ws)

      clientRoom.set(ws,roomId)

      const savedCode = roomCode.get(roomId)

      if(savedCode){

        ws.send(JSON.stringify({
          type:"code-update",
          changes:savedCode,
          userId:"server"
        }))
      }

      console.log(`Client joined room ${roomId}`)

      return
    }

    if(parsed.type==="code-update"){

      const roomId = clientRoom.get(ws)

      if(!roomId)return

      roomCode.set(roomId,parsed.changes)

      const room = rooms.get(roomId)

      if(!room)return

      room.forEach((client)=>{

        if(client!==ws && client.readyState===WebSocket.OPEN){

          client.send(JSON.stringify(parsed))
        }
      })

      return
    }

    if(parsed.type==="cursor-update"){

      const roomId = clientRoom.get(ws)

      if(!roomId)return

      const room = rooms.get(roomId)

      if(!room)return

      room.forEach((client)=>{

        if(client!==ws && client.readyState===WebSocket.OPEN){

          client.send(JSON.stringify(parsed))
        }
      })

      return
    }
  })

  ws.on("close",()=>{

    const roomId = clientRoom.get(ws)

    if(roomId){

      rooms.get(roomId)?.delete(ws)

      clientRoom.delete(ws)
    }

    console.log("Client disconnected")
  })
})

app.use(cors())
app.use(express.json())

app.use("/",executionRoutes)

app.get("/",(_,res)=>{
  res.send("Server Running")
})

server.listen(PORT,()=>{
  console.log(`Server running on port ${PORT}`)
})