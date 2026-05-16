export type JoinMessage={
  type:"join"
  roomId:string
  userId:string
}

export type CodeUpdateMessage={
  type:"code-update"
  roomId:string
  changes:string
  userId:string
}

export type CursorUpdateMessage={
  type:"cursor-update"
  roomId:string
  line:number
  column:number
  userId:string
}

export type WSMessage=
| JoinMessage
| CodeUpdateMessage
| CursorUpdateMessage