import assert from "node:assert/strict"
import { test } from "node:test"
import { RoomLifecycle } from "../../src/collaboration/roomLifecycle.js"

test("deletion invalidates in-flight room epochs and blocks joins until completion", () => {
  const lifecycle = new RoomLifecycle()
  const oldEpoch = lifecycle.capture("room-a")!
  lifecycle.beginDeletion("room-a")
  assert.equal(lifecycle.isCurrent("room-a", oldEpoch), false)
  assert.equal(lifecycle.capture("room-a"), null)
  lifecycle.finishDeletion("room-a")
  const reusedEpoch = lifecycle.capture("room-a")!
  assert.notEqual(reusedEpoch, oldEpoch)
  assert.equal(lifecycle.isCurrent("room-a", oldEpoch), false)
  assert.equal(lifecycle.isCurrent("room-a", reusedEpoch), true)
  lifecycle.release("room-a", oldEpoch)
  lifecycle.release("room-a", reusedEpoch)
})

test("nested file and project deletion share one fence until both finish", () => {
  const lifecycle = new RoomLifecycle()
  let notifications = 0
  lifecycle.onDeleting(() => { notifications += 1 })
  const epoch = lifecycle.capture("room-b")!
  lifecycle.beginDeletion("room-b")
  lifecycle.beginDeletion("room-b")
  assert.equal(notifications, 1)
  lifecycle.finishDeletion("room-b")
  assert.equal(lifecycle.isDeleting("room-b"), true)
  assert.equal(lifecycle.capture("room-b"), null)
  lifecycle.finishDeletion("room-b")
  assert.equal(lifecycle.isDeleting("room-b"), false)
  assert.equal(lifecycle.isCurrent("room-b", epoch), false)
  lifecycle.release("room-b", epoch)
})

test("deletion drain waits for work already authorized by the active room epoch", async () => {
  const lifecycle = new RoomLifecycle()
  const epoch = lifecycle.capture("room-c")!
  const release = lifecycle.acquireOperation("room-c", epoch)!
  lifecycle.beginDeletion("room-c")
  let drained = false
  const drain = lifecycle.drain("room-c").then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  assert.equal(lifecycle.acquireOperation("room-c", epoch), null)
  release()
  await drain
  assert.equal(drained, true)
  lifecycle.finishDeletion("room-c")
  lifecycle.release("room-c", epoch)
})

test("an in-flight document load is discarded after deletion and cannot serve reused IDs", async () => {
  const lifecycle = new RoomLifecycle()
  const oldEpoch = lifecycle.capture("room-d")!
  let resolveLoad!: (value: string) => void
  let discarded = false
  const loading = lifecycle.load("room-d", oldEpoch, () => new Promise<string>((resolve) => { resolveLoad = resolve }), () => { discarded = true })
  lifecycle.beginDeletion("room-d")
  lifecycle.finishDeletion("room-d")
  resolveLoad("deleted document")
  await assert.rejects(loading, /Room is being deleted or has changed/)
  assert.equal(discarded, true)
  const newEpoch = lifecycle.capture("room-d")!
  assert.notEqual(newEpoch, oldEpoch)
  assert.equal(lifecycle.isCurrent("room-d", newEpoch), true)
  lifecycle.release("room-d", oldEpoch)
  lifecycle.release("room-d", newEpoch)
})
