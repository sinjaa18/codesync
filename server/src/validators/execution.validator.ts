import { z } from "zod"
import { languageValues } from "../execution/languages.js"

export const codeSchema = z.object({
  code: z.string().max(10_000).refine((code) => Buffer.byteLength(code, "utf8") <= 10_000, "Source code must be at most 10 KB.").refine((code) => code.trim().length > 0, "Source code cannot be empty."),
  language: z.enum(languageValues),
  stdin: z.string().max(10_000).refine((stdin) => Buffer.byteLength(stdin, "utf8") <= 10_000, "Standard input must be at most 10 KB.").optional().default(""),
}).strict()

export type CodeExecutionRequest = z.infer<typeof codeSchema>
