import { Router } from "express"
import type { Request,Response,NextFunction } from "express"
import type { ZodTypeAny } from "zod"

import { codeSchema } from "../validators/execution.validator.js"
import { runCode } from "../controllers/execution.controller.js"

const router = Router()
const requests = new Map<string, { count: number; resetAt: number }>()

const limitExecution = (req: Request, res: Response, next: NextFunction) => {
  const now = Date.now()
  const key = req.ip || "unknown"
  const current = requests.get(key)
  if (!current || current.resetAt <= now) {
    if (requests.size > 10_000) {
      for (const [ip, entry] of requests) if (entry.resetAt <= now) requests.delete(ip)
    }
    requests.set(key, { count: 1, resetAt: now + 60_000 })
    next()
    return
  }
  if (current.count >= 10) {
    res.status(429).json({ error: "Execution limit reached. Try again in a minute." })
    return
  }
  current.count += 1
  next()
}

const validate=
(schema:ZodTypeAny)=>
(req:Request,res:Response,next:NextFunction)=>{

  const result = schema.safeParse(req.body)

  if(!result.success){
    return res.status(400).json({
      error:result.error.format()
    })
  }

  req.body=result.data

  next()
}

router.post("/run", validate(codeSchema), limitExecution, runCode)

export default router
