import * as Y from "yjs"
import { randomUUID } from "node:crypto"
import { prisma } from "../db/client.js"
import { roomLifecycle } from "../collaboration/roomLifecycle.js"

const accessRevocationListeners = new Set<(projectId: string, userId: string) => void>()
const projectDeletionListeners = new Set<(projectId: string) => void>()
const projectDeletionAbortedListeners = new Set<(projectId: string) => void>()
const projectDeletionsInProgress = new Set<string>()

export function onProjectAccessRevoked(listener: (projectId: string, userId: string) => void) {
  accessRevocationListeners.add(listener)
}

export function onProjectDeleting(listener: (projectId: string) => void) {
  projectDeletionListeners.add(listener)
}

export function onProjectDeletionAborted(listener: (projectId: string) => void) {
  projectDeletionAbortedListeners.add(listener)
}

export async function getProjectRole(projectId: string, userId: string) {
  const membership = await prisma.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  })
  return membership?.role ?? null
}

export async function createProject(ownerId: string, name: string) {
  const project = await prisma.project.create({
    data: {
      name,
      ownerId,
      memberships: { create: { userId: ownerId, role: "OWNER" } },
    },
    select: { id: true, name: true, ownerId: true, createdAt: true, updatedAt: true },
  })
  return project
}

export async function createProjectFile(projectId: string, userId: string, path: string) {
  const role = await getProjectRole(projectId, userId)
  if (role !== "OWNER" && role !== "EDITOR") return null

  const doc = new Y.Doc()
  doc.getText("code").insert(0, "")
  const update = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  const fileId = `file_${randomUUID().replaceAll("-", "")}`
  const roomId = `f_${randomUUID().replaceAll("-", "")}`
  return prisma.$transaction(async (tx) => {
    await tx.room.create({
      data: {
        id: roomId,
        ownerId: userId,
        projectId,
        updates: { create: { update } },
      },
    })
    return tx.file.create({
      data: { id: fileId, projectId, path, roomId },
      select: { id: true, projectId: true, path: true, content: true, roomId: true, createdAt: true, updatedAt: true },
    })
  })
}

export async function inviteProjectMember(projectId: string, ownerId: string, memberId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
  if (project?.ownerId !== ownerId) return false
  if (ownerId === memberId) return true
  await prisma.projectMembership.upsert({
    where: { projectId_userId: { projectId, userId: memberId } },
    create: { projectId, userId: memberId, role: "EDITOR" },
    update: { role: "EDITOR" },
  })
  return true
}

export async function revokeProjectMembership(projectId: string, ownerId: string, memberId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
  if (project?.ownerId !== ownerId) return false
  if (ownerId === memberId) return false
  const { count } = await prisma.projectMembership.deleteMany({
    where: { projectId, userId: memberId }
  })
  if (count) {
    for (const listener of accessRevocationListeners) listener(projectId, memberId)
  }
  return count > 0
}

export async function deleteProject(projectId: string, ownerId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
  if (project?.ownerId !== ownerId) return false
  if (projectDeletionsInProgress.has(projectId)) return false
  projectDeletionsInProgress.add(projectId)
  for (const listener of projectDeletionListeners) listener(projectId)
  const deletingRooms: string[] = []
  try {
    const rooms = await prisma.room.findMany({ where: { projectId }, select: { id: true } })
    for (const room of rooms) {
      roomLifecycle.beginDeletion(room.id)
      deletingRooms.push(room.id)
    }
    await Promise.all(deletingRooms.map((roomId) => roomLifecycle.drain(roomId)))
    await prisma.$transaction(async (tx) => {
      // Room.projectId uses SetNull for legacy standalone rooms, so delete every
      // project room explicitly to cascade its Yjs updates and chat history.
      await tx.room.deleteMany({ where: { projectId } })
      await tx.project.delete({ where: { id: projectId } })
    })
    return true
  } catch (error) {
    for (const listener of projectDeletionAbortedListeners) listener(projectId)
    throw error
  } finally {
    for (const roomId of deletingRooms) roomLifecycle.finishDeletion(roomId)
    projectDeletionsInProgress.delete(projectId)
  }
}

export async function getProjectJoinRequests(projectId: string, ownerId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
  if (project?.ownerId !== ownerId) return []
  const requests = await prisma.projectJoinRequest.findMany({
    where: { projectId },
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: "asc" }
  })
  return requests
}

export async function approveProjectJoinRequest(projectId: string, ownerId: string, memberId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
  if (project?.ownerId !== ownerId) return false
  const request = await prisma.projectJoinRequest.findUnique({ where: { projectId_userId: { projectId, userId: memberId } } })
  if (!request) return false
  await prisma.$transaction([
    prisma.projectMembership.upsert({
      where: { projectId_userId: { projectId, userId: memberId } },
      create: { projectId, userId: memberId, role: "EDITOR" },
      update: { role: "EDITOR" },
    }),
    prisma.projectJoinRequest.delete({ where: { projectId_userId: { projectId, userId: memberId } } })
  ])
  return true
}

export async function rejectProjectJoinRequest(projectId: string, ownerId: string, memberId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
  if (project?.ownerId !== ownerId) return false
  const { count } = await prisma.projectJoinRequest.deleteMany({ where: { projectId, userId: memberId } })
  return count > 0
}
