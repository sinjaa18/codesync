export type JoinMessage={
  type:"join"
  roomId:string
  userId:string
  stateVector?:string
}

export type DocumentUpdateMessage={
  type:"doc-update"
  roomId:string
  update:string
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
| DocumentUpdateMessage
| CursorUpdateMessage
