import assert from "node:assert/strict"
import { test } from "node:test"
import { createApprovalGuard, reconcileJoinRequest } from "../../../client/src/joinRequest.js"

test("approval status auto-connects once reconciliation runs and ignores duplicate push through database status", async () => {
  let connections = 0
  let rejections = 0
  const guard = createApprovalGuard()
  const readStatus = async () => ({ approved: true, pending: false })
  assert.equal(await reconcileJoinRequest(readStatus, () => { guard.run(() => { connections += 1 }) }, () => { rejections += 1 }), "approved")
  assert.equal(await reconcileJoinRequest(readStatus, () => { guard.run(() => { connections += 1 }) }, () => { rejections += 1 }), "approved")
  assert.equal(connections, 1, "duplicate approval signals do not start duplicate room connections")
  assert.equal(rejections, 0)
})

test("pending status waits and missing request clears the pending state as rejection", async () => {
  let connections = 0
  let rejections = 0
  assert.equal(await reconcileJoinRequest(async () => ({ approved: false, pending: true }), () => { connections += 1 }, () => { rejections += 1 }), "pending")
  assert.equal(await reconcileJoinRequest(async () => ({ approved: false, pending: false }), () => { connections += 1 }, () => { rejections += 1 }), "rejected")
  assert.equal(connections, 0)
  assert.equal(rejections, 1)
})

test("approval wins over a stale pending row", async () => {
  let connections = 0
  assert.equal(await reconcileJoinRequest(async () => ({ approved: true, pending: true }), () => { connections += 1 }, () => assert.fail("must not reject an approved member")), "approved")
  assert.equal(connections, 1)
})
