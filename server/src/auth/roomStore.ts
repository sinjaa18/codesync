import * as Y from "yjs"
import { prisma } from "../db/client.js"
import { roomLifecycle } from "../collaboration/roomLifecycle.js"

function createInitialUpdate() {
  const doc = new Y.Doc()
  doc.getText("code").insert(0, "console.log('Hello from CodeSync')")
  const update = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return update
}

export async function ensureRoomAccess(roomId: string, userId: string) {
  if (roomLifecycle.isDeleting(roomId)) return { created: false, allowed: false }
  const existing = await prisma.room.findUnique({
    where: { id: roomId },
    include: { memberships: { where: { userId }, select: { userId: true } } },
  })
  if (existing) {
    if (roomLifecycle.isDeleting(roomId)) return { created: false, allowed: false }
    const projectMember = existing.projectId
      ? await prisma.projectMembership.findUnique({ where: { projectId_userId: { projectId: existing.projectId, userId } }, select: { userId: true } })
      : null
    if (roomLifecycle.isDeleting(roomId)) return { created: false, allowed: false }
    return { created: false, allowed: existing.memberships.length > 0 || Boolean(projectMember) }
  }

  if (roomLifecycle.isDeleting(roomId)) return { created: false, allowed: false }

  try {
    await prisma.room.create({
      data: {
        id: roomId,
        ownerId: userId,
        memberships: { create: { userId, role: "OWNER" } },
        updates: { create: { update: createInitialUpdate() } },
      },
    })
    if (roomLifecycle.isDeleting(roomId)) return { created: false, allowed: false }
    return { created: true, allowed: true }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      if (roomLifecycle.isDeleting(roomId)) return { created: false, allowed: false }
      const room = await prisma.room.findUnique({ where: { id: roomId }, include: { memberships: { where: { userId } } } })
      const projectMember = room?.projectId ? await prisma.projectMembership.findUnique({ where: { projectId_userId: { projectId: room.projectId, userId } }, select: { userId: true } }) : null
      if (roomLifecycle.isDeleting(roomId)) return { created: false, allowed: false }
      return { created: false, allowed: Boolean(room?.memberships.length || projectMember) }
    }
    throw error
  }
}

export async function inviteRoomMember(roomId: string, ownerId: string, memberId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { ownerId: true } })
  if (room?.ownerId !== ownerId) return false
  if (ownerId === memberId) return true
  await prisma.roomMembership.upsert({
    where: { roomId_userId: { roomId, userId: memberId } },
    create: { roomId, userId: memberId, role: "MEMBER" },
    update: { role: "MEMBER" },
  })
  return true
}

export async function hasRoomAccess(roomId: string, userId: string) {
  if (roomLifecycle.isDeleting(roomId)) return false
  const membership = await prisma.roomMembership.findUnique({ where: { roomId_userId: { roomId, userId } }, select: { userId: true } })
  if (roomLifecycle.isDeleting(roomId)) return false
  if (membership) return true
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { projectId: true } })
  if (roomLifecycle.isDeleting(roomId)) return false
  if (!room?.projectId) return false
  const projectMember = await prisma.projectMembership.findUnique({ where: { projectId_userId: { projectId: room.projectId, userId } }, select: { role: true } })
  if (roomLifecycle.isDeleting(roomId)) return false
  return projectMember?.role === "OWNER" || projectMember?.role === "EDITOR"
}

export async function createJoinRequest(roomId: string, userId: string) {
  if (roomLifecycle.isDeleting(roomId)) return null
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { ownerId: true, projectId: true } })
  if (!room || roomLifecycle.isDeleting(roomId)) return null
  if (room.projectId) {
    const inserted = await prisma.projectJoinRequest.createMany({ data: { projectId: room.projectId, userId }, skipDuplicates: true })
    const project = await prisma.project.findUnique({ where: { id: room.projectId }, select: { ownerId: true } })
    return { type: "project" as const, targetId: room.projectId, ownerId: project?.ownerId ?? room.ownerId, created: inserted.count > 0 }
  }
  const inserted = await prisma.roomJoinRequest.createMany({ data: { roomId, userId }, skipDuplicates: true })
  return { type: "room" as const, targetId: roomId, ownerId: room.ownerId, created: inserted.count > 0 }
}

export async function getRoomJoinRequests(roomId: string, ownerId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { ownerId: true } })
  if (room?.ownerId !== ownerId) return []
  return prisma.roomJoinRequest.findMany({
    where: { roomId },
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: "asc" }
  })
}

export async function getRoomJoinRequestStatus(roomId: string, userId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { projectId: true } })
  if (!room) return null
  const approved = await hasRoomAccess(roomId, userId)
  if (approved) return { approved: true, pending: false }
  const pending = room.projectId
    ? Boolean(await prisma.projectJoinRequest.findUnique({ where: { projectId_userId: { projectId: room.projectId, userId } }, select: { userId: true } }))
    : Boolean(await prisma.roomJoinRequest.findUnique({ where: { roomId_userId: { roomId, userId } }, select: { userId: true } }))
  return { approved: false, pending }
}

export async function approveRoomJoinRequest(roomId: string, ownerId: string, memberId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { ownerId: true } })
  if (room?.ownerId !== ownerId) return false
  const request = await prisma.roomJoinRequest.findUnique({ where: { roomId_userId: { roomId, userId: memberId } } })
  if (!request) return false
  await prisma.$transaction([
    prisma.roomMembership.upsert({
      where: { roomId_userId: { roomId, userId: memberId } },
      create: { roomId, userId: memberId, role: "MEMBER" },
      update: { role: "MEMBER" },
    }),
    prisma.roomJoinRequest.delete({ where: { roomId_userId: { roomId, userId: memberId } } })
  ])
  return true
}

export async function rejectRoomJoinRequest(roomId: string, ownerId: string, memberId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { ownerId: true } })
  if (room?.ownerId !== ownerId) return false
  const { count } = await prisma.roomJoinRequest.deleteMany({ where: { roomId, userId: memberId } })
  return count > 0
}

export async function getRoomPresenceContext(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { projectId: true, file: { select: { id: true, path: true } } },
  })
  if (!room) return null
  return { projectId: room.projectId, fileId: room.file?.id ?? null, filePath: room.file?.path ?? null }
}

export async function loadRoomDocument(roomId: string) {
  const updates = await prisma.documentUpdate.findMany({ where: { roomId }, orderBy: { id: "asc" }, select: { update: true } })
  const doc = new Y.Doc()
  for (const entry of updates) Y.applyUpdate(doc, new Uint8Array(entry.update))
  return doc
}

export async function deleteRoom(roomId: string) {
  roomLifecycle.beginDeletion(roomId)
  try {
    await roomLifecycle.drain(roomId)
    await prisma.room.delete({ where: { id: roomId } })
  } finally {
    roomLifecycle.finishDeletion(roomId)
  }
}

export async function persistRoomUpdate(roomId: string, update: Uint8Array, content: string) {
  await prisma.$transaction([
    prisma.documentUpdate.create({ data: { roomId, update: Buffer.from(update) } }),
    prisma.room.update({ where: { id: roomId }, data: { updatedAt: new Date() } }),
    prisma.file.updateMany({ where: { roomId }, data: { content } }),
  ])
}

export async function listRoomChatMessages(roomId: string, limit = 100) {
  return prisma.chatMessage.findMany({
    where: { roomId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: { author: { select: { id: true, username: true } } },
  }).then((messages) => messages.reverse())
}

export async function saveRoomChatMessage(roomId: string, authorId: string, clientMessageId: string, content: string) {
  return prisma.chatMessage.upsert({
    where: { roomId_authorId_clientMessageId: { roomId, authorId, clientMessageId } },
    create: { roomId, authorId, clientMessageId, content },
    update: {},
    include: { author: { select: { id: true, username: true } } },
  })
}
