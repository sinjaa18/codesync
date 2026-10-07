import { z } from "zod"

export const codeSchema = z.object({
  code: z.string().min(1).max(10_000),
  language: z.enum(["javascript", "typescript", "python", "cpp", "java"]),
  stdin: z.string().max(10_000).optional().default(""),
})

export type CodeExecutionRequest = z.infer<typeof codeSchema>
