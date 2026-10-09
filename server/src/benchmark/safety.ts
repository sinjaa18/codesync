const allowedDatabaseName = "codesync_test"
const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

export type BenchmarkOptions = {
  allowLocalTarget: boolean
  maxClients: number
  requestsPerRepetition: number
  repetitions: number
}

export function assertSafeBenchmarkTarget(databaseUrl: string | undefined, allowLocalTarget: boolean) {
  if (!allowLocalTarget) {
    throw new Error("Benchmark is opt-in. Pass --allow-local-target to confirm a local test run.")
  }
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required and must target the dedicated local codesync_test database.")
  }

  let target: URL
  try {
    target = new URL(databaseUrl)
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL for the dedicated local codesync_test database.")
  }

  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, "").split("/")[0] ?? "")
  if (!(["postgresql:", "postgres:"].includes(target.protocol)
    && allowedHosts.has(target.hostname.toLowerCase())
    && databaseName === allowedDatabaseName)) {
    throw new Error("Refusing benchmark target. DATABASE_URL must use PostgreSQL on loopback and database codesync_test.")
  }
}

export function parseBenchmarkOptions(args: string[]): BenchmarkOptions {
  const values: Record<string, string> = {}
  let allowLocalTarget = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--allow-local-target") {
      allowLocalTarget = true
      continue
    }
    if (!["--max-clients", "--requests", "--repetitions"].includes(arg)) {
      throw new Error(`Unknown benchmark option: ${arg}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`)
    values[arg] = value
    index += 1
  }

  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = values[key]
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number between ${min} and ${max}.`)
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be a whole number between ${min} and ${max}.`)
    }
    return value
  }

  return {
    allowLocalTarget,
    maxClients: integer("--max-clients", 10, 2, 25),
    requestsPerRepetition: integer("--requests", 30, 10, 100),
    repetitions: integer("--repetitions", 3, 1, 5),
  }
}
