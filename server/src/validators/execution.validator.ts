import { z } from "zod"

export const codeSchema = z.object({
  code:z.string().nonempty(),
  language:z.string().min(2)
})

export type CodeExecutionRequest = z.infer<typeof codeSchema>