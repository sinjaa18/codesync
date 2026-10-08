export const languageIds = {
  javascript: 63,
  typescript: 74,
  python: 71,
  cpp: 54,
  java: 62,
} as const

export type SupportedLanguage = keyof typeof languageIds

export const languageOptions: { id: SupportedLanguage; name: string }[] = [
  { id: "javascript", name: "JavaScript" },
  { id: "typescript", name: "TypeScript" },
  { id: "python", name: "Python" },
  { id: "cpp", name: "C++" },
  { id: "java", name: "Java" },
]

export const languageValues = Object.keys(languageIds) as [SupportedLanguage, ...SupportedLanguage[]]
