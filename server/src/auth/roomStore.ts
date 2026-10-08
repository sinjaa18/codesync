type RoomAccess = { ownerId: string; members: Set<string> }
const rooms = new Map<string, RoomAccess>()

export function ensureRoomAccess(roomId: string, userId: string) {
  const room = rooms.get(roomId)
  if (!room) {
    rooms.set(roomId, { ownerId: userId, members: new Set([userId]) })
    return { created: true, allowed: true }
  }
  return { created: false, allowed: room.members.has(userId) }
}

export function inviteRoomMember(roomId: string, ownerId: string, memberId: string) {
  const room = rooms.get(roomId)
  if (!room || room.ownerId !== ownerId) return false
  room.members.add(memberId)
  return true
}

export function hasRoomAccess(roomId: string, userId: string) {
  return rooms.get(roomId)?.members.has(userId) ?? false
}
