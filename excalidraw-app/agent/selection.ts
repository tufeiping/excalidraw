import type { SelectionHandle, SelectionStore } from "./types";

/**
 * Remembers which elements the model was shown by `read_selection`, so
 * `replace_selection` can edit exactly that range instead of re-guessing.
 */
export class InMemorySelectionStore implements SelectionStore {
  private handles = new Map<string, SelectionHandle>();
  private bySignature = new Map<string, SelectionHandle>();
  private lastHandle: SelectionHandle | null = null;
  private counter = 0;

  register(ids: string[], rev: number): SelectionHandle {
    const signature = `${rev}|${ids.join(",")}`;
    const existing = this.bySignature.get(signature);
    if (existing) {
      this.lastHandle = existing;
      return existing;
    }

    const handle: SelectionHandle = {
      id: `sel_${++this.counter}`,
      ids: [...ids],
      rev,
      createdAt: Date.now(),
    };

    this.handles.set(handle.id, handle);
    this.bySignature.set(signature, handle);
    this.lastHandle = handle;

    // keep the store from growing unbounded across a long session
    if (this.handles.size > 24) {
      const [oldestId] = this.handles.keys();
      const oldest = this.handles.get(oldestId);
      this.handles.delete(oldestId);
      if (oldest) {
        this.bySignature.delete(`${oldest.rev}|${oldest.ids.join(",")}`);
      }
    }

    return handle;
  }

  get(id: string) {
    return this.handles.get(id);
  }

  last() {
    return this.lastHandle;
  }
}
