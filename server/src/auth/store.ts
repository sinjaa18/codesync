import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const scrypt = promisify(scryptCallback)
const sessionLifetimeMs = 60 * 60 * 1000

export type User = { id: string; username: string }
type StoredUser = User & { salt: string; passwordHash: string }
type Session = { userId: string; expiresAt: number }

const usersById = new Map<string, StoredUser>()
const userIdsByName = new Map<string, string>()
const sessions = new Map<string, Session>()
const pendingUsernames = new Set<string>()
const revocationListeners = new Set<(key: string) => void>()

const normalizeUsername = (username: string) => username.trim().toLowerCase()
const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex")

export function findUserByName(username: string) {
  const id = userIdsByName.get(normalizeUsername(username))
  return id ? findUserById(id) : undefined
}

export function findUserById(id: string): User | undefined {
  const user = usersById.get(id)
  return user && { id: user.id, username: user.username }
}

export async function createUser(username: string, password: string): Promise<User | undefined> {
  const normalized = normalizeUsername(username)
  if (userIdsByName.has(normalized) || pendingUsernames.has(normalized)) return undefined
  pendingUsernames.add(normalized)
  try {
    const salt = randomBytes(16).toString("hex")
    const passwordHash = (await scrypt(password, salt, 64)) as Buffer
    const user = { id: randomBytes(16).toString("hex"), username: username.trim(), salt, passwordHash: passwordHash.toString("hex") }
    usersById.set(user.id, user)
    userIdsByName.set(normalized, user.id)
    return { id: user.id, username: user.username }
  } finally {
    pendingUsernames.delete(normalized)
  }
}

export async function verifyPassword(username: string, password: string) {
  const id = userIdsByName.get(normalizeUsername(username))
  const user = id ? usersById.get(id) : undefined
  if (!user) {
    await scrypt(password, "codesync-invalid-user", 64)
    return undefined
  }
  const candidate = (await scrypt(password, user.salt, 64)) as Buffer
  const expected = Buffer.from(user.passwordHash, "hex")
  return timingSafeEqual(candidate, expected) ? findUserById(user.id) : undefined
}

export function createSession(userId: string) {
  for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key)
  const token = randomBytes(32).toString("base64url")
  const key = tokenKey(token)
  const expiresAt = Date.now() + sessionLifetimeMs
  sessions.set(key, { userId, expiresAt })
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

export function getSession(token: string) {
  return getSessionByKey(tokenKey(token))
}

export function getSessionByKey(key: string) {
  const session = sessions.get(key)
  if (!session) return undefined
  if (session.expiresAt <= Date.now()) {
    sessions.delete(key)
    return undefined
  }
  const user = findUserById(session.userId)
  return user ? { key, user, expiresAt: session.expiresAt } : undefined
}

export function revokeSession(token: string) {
  const key = tokenKey(token)
  const revoked = sessions.delete(key)
  if (revoked) for (const listener of revocationListeners) listener(key)
  return revoked
}

export function onSessionRevoked(listener: (key: string) => void) {
  revocationListeners.add(listener)
}
