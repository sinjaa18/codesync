import type { Request,Response } from "express"
import type { CodeExecutionRequest } from "../validators/execution.validator.js"
import type { CodeExecutionResponse } from "../types/execution.types.js"

export const runCode=(
  req:Request<{}, {}, CodeExecutionRequest>,
  res:Response<CodeExecutionResponse>
)=>{
  const { code,language } = req.body
  const start = Date.now()
  try{
    if(language!=="javascript"){
      return res.json({
        stdout:"",
        stderr:"Only JavaScript supported currently",
        executionTimeMs:0,
        success:false
      })
    }
    let output = ""
    const originalLog = console.log
    console.log=(...args)=>{
      output += args.join(" ") + "\n"
    }
    eval(code)
    console.log = originalLog
    const result:CodeExecutionResponse={
      stdout:output,
      stderr:"",
      executionTimeMs:Date.now()-start,
      success:true
    }

    res.json(result)

  }catch(err){

    const result:CodeExecutionResponse={
      stdout:"",
      stderr:String(err),
      executionTimeMs:Date.now()-start,
      success:false
    }

    res.json(result)
  }
}