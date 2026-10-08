import { PrismaClient } from "@prisma/client"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required to start the server.")

export const prisma = new PrismaClient()
