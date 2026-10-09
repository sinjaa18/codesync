import { Router } from "express"
import { z } from "zod"
import { prisma } from "../db/client.js"
import { findUserByName, wsEvents } from "../auth/store.js"
import { createProject, createProjectFile, getProjectRole, inviteProjectMember, revokeProjectMembership, deleteProject, getProjectJoinRequests, approveProjectJoinRequest, rejectProjectJoinRequest } from "../auth/projectStore.js"
import { requireAuth } from "../auth/middleware.js"
import { logWarn } from "../observability/logger.js"

const router = Router()
router.use(requireAuth)
const projectIdSchema = z.string().min(1).max(64)
const filePathSchema = z.string().trim().min(1).max(240).refine((path) =>
  !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== ".." && /^[\w.-]+$/.test(part)),
  "Use a relative file path with letters, numbers, dots, underscores, or hyphens.",
)

router.get("/", async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { memberships: { some: { userId: res.locals.userId! } } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, ownerId: true, createdAt: true, updatedAt: true, memberships: { where: { userId: res.locals.userId! }, select: { role: true } } },
  })
  res.json(projects.map(({ memberships, ...project }) => ({ ...project, role: memberships[0]?.role })))
})

router.post("/", async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(80) }).strict().safeParse(req.body)
  if (!body.success) return res.status(400).json({ error: "Project name must be between 1 and 80 characters." })
  res.status(201).json(await createProject(res.locals.userId!, body.data.name))
})

router.get("/:projectId/files", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  if (!projectId.success) return res.status(400).json({ error: "Invalid project ID." })
  const role = await getProjectRole(projectId.data, res.locals.userId!)
  if (!role) {
    logWarn("authorization.project_denied", { requestId: res.locals.requestId, userId: res.locals.userId, projectId: projectId.data })
    return res.status(404).json({ error: "Project not found." })
  }
  const files = await prisma.file.findMany({ where: { projectId: projectId.data }, orderBy: { path: "asc" }, select: { id: true, projectId: true, path: true, content: true, roomId: true, createdAt: true, updatedAt: true } })
  res.json(files)
})

router.post("/:projectId/files", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  const body = z.object({ path: filePathSchema }).strict().safeParse(req.body)
  if (!projectId.success || !body.success) return res.status(400).json({ error: "Invalid project ID or file path." })
  try {
    const file = await createProjectFile(projectId.data, res.locals.userId!, body.data.path)
    if (!file) {
      logWarn("authorization.file_write_denied", { requestId: res.locals.requestId, userId: res.locals.userId, projectId: projectId.data })
      return res.status(404).json({ error: "Project not found or you do not have edit access." })
    }
    res.status(201).json(file)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return res.status(409).json({ error: "A file already exists at that path." })
    throw error
  }
})

router.patch("/:projectId/files/:fileId", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  const fileId = z.string().min(1).max(64).safeParse(req.params.fileId)
  const body = z.object({ path: filePathSchema }).strict().safeParse(req.body)
  if (!projectId.success || !fileId.success || !body.success) return res.status(400).json({ error: "Invalid project ID, file ID, or file path." })
  const role = await getProjectRole(projectId.data, res.locals.userId!)
  if (role !== "OWNER" && role !== "EDITOR") {
    logWarn("authorization.file_write_denied", { requestId: res.locals.requestId, userId: res.locals.userId, projectId: projectId.data, fileId: fileId.data })
    return res.status(404).json({ error: "File not found or you do not have edit access." })
  }
  try {
    const result = await prisma.file.updateMany({ where: { id: fileId.data, projectId: projectId.data }, data: { path: body.data.path } })
    if (!result.count) return res.status(404).json({ error: "File not found." })
    const file = await prisma.file.findUnique({ where: { id: fileId.data }, select: { id: true, projectId: true, path: true, content: true, roomId: true, createdAt: true, updatedAt: true } })
    res.json(file)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return res.status(409).json({ error: "A file already exists at that path." })
    throw error
  }
})

router.delete("/:projectId/files/:fileId", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  const fileId = z.string().min(1).max(64).safeParse(req.params.fileId)
  if (!projectId.success || !fileId.success) return res.status(400).json({ error: "Invalid project ID or file ID." })
  const role = await getProjectRole(projectId.data, res.locals.userId!)
  if (role !== "OWNER" && role !== "EDITOR") {
    logWarn("authorization.file_write_denied", { requestId: res.locals.requestId, userId: res.locals.userId, projectId: projectId.data, fileId: fileId.data })
    return res.status(404).json({ error: "File not found or you do not have edit access." })
  }
  const file = await prisma.file.findFirst({ where: { id: fileId.data, projectId: projectId.data }, select: { roomId: true } })
  if (!file) return res.status(404).json({ error: "File not found." })
  if (file.roomId) await prisma.room.delete({ where: { id: file.roomId } })
  else await prisma.file.delete({ where: { id: fileId.data } })
  res.status(204).end()
})

router.post("/:projectId/invites", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  const body = z.object({ username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/) }).strict().safeParse(req.body)
  if (!projectId.success || !body.success) return res.status(400).json({ error: "Invalid project ID or username." })
  const user = await findUserByName(body.data.username)
  if (!user) return res.status(404).json({ error: "No account found for that username." })
  if (!await inviteProjectMember(projectId.data, res.locals.userId!, user.id)) {
    logWarn("authorization.project_invite_denied", { requestId: res.locals.requestId, userId: res.locals.userId, projectId: projectId.data })
    return res.status(403).json({ error: "Only the project owner can invite participants." })
  }
  res.status(204).end()
})

router.get("/:projectId/requests", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  if (!projectId.success) return res.status(400).json({ error: "Invalid project ID." })
  const requests = await getProjectJoinRequests(projectId.data, res.locals.userId!)
  res.json(requests)
})

router.post("/:projectId/requests/:username/approve", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  const username = z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/).safeParse(req.params.username)
  if (!projectId.success || !username.success) return res.status(400).json({ error: "Invalid project ID or username." })
  const user = await findUserByName(username.data)
  if (!user) return res.status(404).json({ error: "User not found." })
  const success = await approveProjectJoinRequest(projectId.data, res.locals.userId!, user.id)
  if (!success) return res.status(403).json({ error: "Could not approve request." })
  wsEvents.emit("request-approved", user.id, projectId.data)
  res.status(204).end()
})

router.delete("/:projectId/requests/:username", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  const username = z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/).safeParse(req.params.username)
  if (!projectId.success || !username.success) return res.status(400).json({ error: "Invalid project ID or username." })
  const user = await findUserByName(username.data)
  if (!user) return res.status(404).json({ error: "User not found." })
  const success = await rejectProjectJoinRequest(projectId.data, res.locals.userId!, user.id)
  if (!success) return res.status(403).json({ error: "Could not reject request." })
  wsEvents.emit("request-rejected", user.id, projectId.data)
  res.status(204).end()
})

router.delete("/:projectId/invites/:username", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  const username = z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/).safeParse(req.params.username)
  if (!projectId.success || !username.success) return res.status(400).json({ error: "Invalid project ID or username." })
  const user = await findUserByName(username.data)
  if (!user) return res.status(404).json({ error: "No account found for that username." })
  if (!await revokeProjectMembership(projectId.data, res.locals.userId!, user.id)) {
    logWarn("authorization.project_revoke_denied", { requestId: res.locals.requestId, userId: res.locals.userId, projectId: projectId.data })
    return res.status(403).json({ error: "Only the project owner can remove participants." })
  }
  res.status(204).end()
})

router.delete("/:projectId", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId)
  if (!projectId.success) return res.status(400).json({ error: "Invalid project ID." })
  if (!await deleteProject(projectId.data, res.locals.userId!)) {
    logWarn("authorization.project_delete_denied", { requestId: res.locals.requestId, userId: res.locals.userId, projectId: projectId.data })
    return res.status(403).json({ error: "Only the project owner can delete the project." })
  }
  res.status(204).end()
})

export default router
