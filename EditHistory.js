/**
 * EditHistory — a tiny undo/redo stack for mesh manipulations.
 *
 * It is intentionally generic: each entry carries its own `undo` and `redo`
 * closures, so the caller decides *what* a step means (restore a position
 * buffer, restore a paint mask + re-displace, …). Pushing a new step clears the
 * redo stack, mirroring every editor's expectation.
 *
 * History is scoped per editing session: callers `clear()` it when the baseline
 * changes (entering a brush mode, swapping geometry, loading a part), so an undo
 * never tries to write a snapshot into a mesh with a different vertex count.
 */
export class EditHistory {
  constructor({ limit = 40, onChange = null } = {}) {
    this.limit = limit;          // cap retained steps so long sessions don't grow unbounded
    this.onChange = onChange;    // (this) => void — refresh button enabled state
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get depth()   { return this.undoStack.length; }

  /** Record a completed manipulation. `undo`/`redo` are idempotent appliers. */
  push(label, undo, redo) {
    this.undoStack.push({ label, undo, redo });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;   // a fresh edit invalidates the redo branch
    this.onChange?.(this);
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo();
    this.redoStack.push(e);
    this.onChange?.(this);
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo();
    this.undoStack.push(e);
    this.onChange?.(this);
    return e.label;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange?.(this);
  }
}
