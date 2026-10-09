import * as Y from "yjs"
import { randomUUID } from "node:crypto"
import { prisma } from "../db/client.js"

const accessRevocationListeners = new Set<(projectId: string, userId: string) => void>()
const projectDeletionListeners = new Set<(projectId: string) => void>()

export function onProjectAccessRevoked(listener: (projectId: string, userId: string) => void) {
  accessRevocationListeners.add(listener)
}

export function onProjectDeleted(listener: (projectId: string) => void) {
  projectDeletionListeners.add(listener)
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
  await prisma.project.delete({ where: { id: projectId } })
  for (const listener of projectDeletionListeners) listener(projectId)
  return true
}

export async function getProjectJoinRequests(projectId: string, ownerId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
  if (project?.ownerId !== ownerId) {
    console.log("getProjectJoinRequests MISMATCH", { projectOwnerId: project?.ownerId, ownerId })
    return []
  }
  const requests = await prisma.projectJoinRequest.findMany({
    where: { projectId },
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: "asc" }
  })
  console.log("getProjectJoinRequests RETURNING", requests.length)
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
