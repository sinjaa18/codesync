export type AuthenticateMessage={
  type:"authenticate"
  token:string
}

export type JoinMessage={
  type:"join"
  roomId:string
  stateVector?:string
}

export type DocumentUpdateMessage={
  type:"doc-update"
  roomId:string
  update:string
}

export type CursorUpdateMessage={
  type:"cursor-update"
  roomId:string
  line:number
  column:number
}

export type WSMessage=
| AuthenticateMessage
| JoinMessage
| DocumentUpdateMessage
| CursorUpdateMessage
