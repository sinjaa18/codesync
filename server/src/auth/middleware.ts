import type { NextFunction, Request, Response } from "express"
import { getSession } from "./store.js"

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authorization = req.header("authorization")
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,60})$/)
  const session = match && await getSession(match[1])
  if (!session) return res.status(401).json({ error: "Authentication required." })
  res.locals.userId = session.user.id
  next()
}

export function getBearerToken(req: Request) {
  return req.header("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{40,60})$/)?.[1]
}
