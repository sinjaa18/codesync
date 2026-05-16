import { Router } from "express"
import type { Request,Response,NextFunction } from "express"
import type { ZodTypeAny } from "zod"

import { codeSchema } from "../validators/execution.validator.js"
import { runCode } from "../controllers/execution.controller.js"

const router = Router()

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

router.post("/run",validate(codeSchema),runCode)

export default router