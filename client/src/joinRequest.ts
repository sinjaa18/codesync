export type JoinRequestStatus = { approved: boolean; pending: boolean }
export type JoinRequestOutcome = "approved" | "pending" | "rejected"

export function joinRequestOutcome(status: JoinRequestStatus): JoinRequestOutcome {
  if (status.approved) return "approved"
  return status.pending ? "pending" : "rejected"
}

export async function reconcileJoinRequest(
  readStatus: () => Promise<JoinRequestStatus>,
  onApproved: () => void,
  onRejected: () => void,
) {
  const outcome = joinRequestOutcome(await readStatus())
  if (outcome === "approved") onApproved()
  else if (outcome === "rejected") onRejected()
  return outcome
}

export function createApprovalGuard() {
  let started = false
  return {
    run(connect: () => void) {
      if (started) return false
      started = true
      connect()
      return true
    },
    reset() {
      started = false
    },
  }
}
