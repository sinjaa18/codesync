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

export type PresenceUpdateMessage={
  type:"presence-update"
  cursor:{ line:number; column:number } | null
}

export type ChatSendMessage={
  type:"chat-send"
  clientMessageId:string
  content:string
}

export type WSMessage=
| AuthenticateMessage
| JoinMessage
| DocumentUpdateMessage
| PresenceUpdateMessage
| ChatSendMessage
