import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { prisma } from "../db/client.js"

const scrypt = promisify(scryptCallback)
const sessionLifetimeMs = 60 * 60 * 1000
const revocationListeners = new Set<(key: string) => void>()

export type User = { id: string; username: string }
const normalizeUsername = (username: string) => username.trim().toLowerCase()
const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex")
const publicUser = (user: { id: string; username: string }): User => ({ id: user.id, username: user.username })

export async function findUserByName(username: string): Promise<User | undefined> {
  const user = await prisma.user.findUnique({ where: { usernameNormalized: normalizeUsername(username) } })
  return user ? publicUser(user) : undefined
}

export async function findUserById(id: string): Promise<User | undefined> {
  const user = await prisma.user.findUnique({ where: { id } })
  return user ? publicUser(user) : undefined
}

export async function createUser(username: string, password: string): Promise<User | undefined> {
  const salt = randomBytes(16).toString("hex")
  const passwordHash = (await scrypt(password, salt, 64)) as Buffer
  try {
    const user = await prisma.user.create({
      data: { username: username.trim(), usernameNormalized: normalizeUsername(username), passwordSalt: salt, passwordHash: passwordHash.toString("hex") },
    })
    return publicUser(user)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return undefined
    throw error
  }
}

export async function verifyPassword(username: string, password: string) {
  const user = await prisma.user.findUnique({ where: { usernameNormalized: normalizeUsername(username) } })
  if (!user) {
    await scrypt(password, "codesync-invalid-user", 64)
    return undefined
  }
  const candidate = (await scrypt(password, user.passwordSalt, 64)) as Buffer
  const expected = Buffer.from(user.passwordHash, "hex")
  return timingSafeEqual(candidate, expected) ? publicUser(user) : undefined
}

export async function createSession(userId: string) {
  const now = new Date()
  await prisma.session.deleteMany({ where: { expiresAt: { lte: now } } })
  const token = randomBytes(32).toString("base64url")
  const key = tokenKey(token)
  const expiresAt = new Date(now.getTime() + sessionLifetimeMs)
  await prisma.session.create({ data: { id: key, userId, expiresAt } })
  return { token, expiresAt: expiresAt.toISOString() }
}

export async function getSession(token: string) {
  return getSessionByKey(tokenKey(token))
}

export async function getSessionByKey(key: string) {
  const session = await prisma.session.findUnique({ where: { id: key }, include: { user: true } })
  if (!session) return undefined
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.deleteMany({ where: { id: key } })
    return undefined
  }
  return { key, user: publicUser(session.user), expiresAt: session.expiresAt.getTime() }
}

export async function revokeSession(token: string) {
  const key = tokenKey(token)
  const { count } = await prisma.session.deleteMany({ where: { id: key } })
  if (count) for (const listener of revocationListeners) listener(key)
  return count > 0
}

export function onSessionRevoked(listener: (key: string) => void) {
  revocationListeners.add(listener)
}
