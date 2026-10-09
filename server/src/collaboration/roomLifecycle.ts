export type RoomEpoch = symbol

export class RoomLifecycle {
  private readonly epochs = new Map<string, RoomEpoch>()
  private readonly references = new Map<RoomEpoch, number>()
  private readonly deleting = new Map<string, number>()
  private readonly operations = new Map<string, number>()
  private readonly drainWaiters = new Map<string, Array<() => void>>()
  private readonly deletionListeners = new Set<(roomId: string) => void>()

  capture(roomId: string): RoomEpoch | null {
    if (this.isDeleting(roomId)) return null
    let epoch = this.epochs.get(roomId)
    if (!epoch) {
      epoch = Symbol(roomId)
      this.epochs.set(roomId, epoch)
    }
    this.references.set(epoch, (this.references.get(epoch) ?? 0) + 1)
    return epoch
  }

  release(roomId: string, epoch: RoomEpoch) {
    const count = this.references.get(epoch) ?? 0
    if (count <= 1) {
      this.references.delete(epoch)
      if (!this.isDeleting(roomId) && this.epochs.get(roomId) === epoch) this.epochs.delete(roomId)
      return
    }
    this.references.set(epoch, count - 1)
  }

  isDeleting(roomId: string) {
    return this.deleting.has(roomId)
  }

  isCurrent(roomId: string, epoch: RoomEpoch) {
    return !this.isDeleting(roomId) && this.epochs.get(roomId) === epoch
  }

  async load<T>(roomId: string, epoch: RoomEpoch, loader: () => Promise<T>, discard: (value: T) => void) {
    const value = await loader()
    if (!this.isCurrent(roomId, epoch)) {
      discard(value)
      throw new RoomLifecycleError()
    }
    return value
  }

  acquireOperation(roomId: string, epoch: RoomEpoch) {
    if (!this.isCurrent(roomId, epoch)) return null
    this.operations.set(roomId, (this.operations.get(roomId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.operations.get(roomId) ?? 0
      if (count <= 1) {
        this.operations.delete(roomId)
        for (const resolve of this.drainWaiters.get(roomId) ?? []) resolve()
        this.drainWaiters.delete(roomId)
      } else {
        this.operations.set(roomId, count - 1)
      }
    }
  }

  async drain(roomId: string) {
    if (!this.operations.get(roomId)) return
    await new Promise<void>((resolve) => {
      const waiters = this.drainWaiters.get(roomId) ?? []
      waiters.push(resolve)
      this.drainWaiters.set(roomId, waiters)
    })
  }

  onDeleting(listener: (roomId: string) => void) {
    this.deletionListeners.add(listener)
  }

  beginDeletion(roomId: string) {
    const count = this.deleting.get(roomId) ?? 0
    this.deleting.set(roomId, count + 1)
    if (count === 0) {
      this.epochs.set(roomId, Symbol(roomId))
      for (const listener of this.deletionListeners) listener(roomId)
    }
  }

  finishDeletion(roomId: string) {
    const count = this.deleting.get(roomId)
    if (!count) return
    if (count > 1) {
      this.deleting.set(roomId, count - 1)
      return
    }
    this.deleting.delete(roomId)
    this.epochs.delete(roomId)
  }
}

export class RoomLifecycleError extends Error {
  constructor() {
    super("Room is being deleted or has changed.")
    this.name = "RoomLifecycleError"
  }
}

export const roomLifecycle = new RoomLifecycle()
