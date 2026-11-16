const MAX_REDO = 100;

/** A person's own strokes (for undo) and the strokes they removed (for redo). */
export class UndoRedo<S extends { id: string }> {
  private own: string[] = [];
  private redo: S[] = [];

  recordDraw(id: string) {
    this.own.push(id);
    this.redo = []; // drawing something new ends the redo chain
  }
  top() { return this.own[this.own.length - 1]; }
  size() { return this.own.length; }
  ids() { return [...this.own]; }
  remove(id: string) { this.own = this.own.filter((x) => x !== id); }
  /** Put a redone stroke back on top without touching the rest of the redo list. */
  restore(id: string) { if (!this.own.includes(id)) this.own.push(id); }
  reset(ids: string[]) { this.own = [...ids]; this.redo = []; }

  pushRedo(s: S) {
    this.redo.push(s);
    if (this.redo.length > MAX_REDO) this.redo.shift();
  }
  popRedo(): S | undefined { return this.redo.pop(); }
  canRedo() { return this.redo.length > 0; }
  redoSize() { return this.redo.length; }
}
