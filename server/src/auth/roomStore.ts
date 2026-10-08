import * as Y from "yjs"
import { prisma } from "../db/client.js"

function createInitialUpdate() {
  const doc = new Y.Doc()
  doc.getText("code").insert(0, "console.log('Hello from CodeSync')")
  const update = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return update
}

export async function ensureRoomAccess(roomId: string, userId: string) {
  const existing = await prisma.room.findUnique({
    where: { id: roomId },
    include: { memberships: { where: { userId }, select: { userId: true } } },
  })
  if (existing) return { created: false, allowed: existing.memberships.length > 0 }

  try {
    await prisma.room.create({
      data: {
        id: roomId,
        ownerId: userId,
        memberships: { create: { userId, role: "OWNER" } },
        updates: { create: { update: createInitialUpdate() } },
      },
    })
    return { created: true, allowed: true }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      const room = await prisma.room.findUnique({ where: { id: roomId }, include: { memberships: { where: { userId } } } })
      return { created: false, allowed: Boolean(room?.memberships.length) }
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
  const membership = await prisma.roomMembership.findUnique({ where: { roomId_userId: { roomId, userId } } })
  return Boolean(membership)
}

export async function loadRoomDocument(roomId: string) {
  const updates = await prisma.documentUpdate.findMany({ where: { roomId }, orderBy: { id: "asc" }, select: { update: true } })
  const doc = new Y.Doc()
  for (const entry of updates) Y.applyUpdate(doc, new Uint8Array(entry.update))
  return doc
}

export async function persistRoomUpdate(roomId: string, update: Uint8Array) {
  await prisma.$transaction([
    prisma.documentUpdate.create({ data: { roomId, update: Buffer.from(update) } }),
    prisma.room.update({ where: { id: roomId }, data: { updatedAt: new Date() } }),
  ])
}
