"use client";

import { useEffect, useState } from "react";
import { newId } from "../lib/ids";
import { nameSchema } from "../shared/protocol";
import Whiteboard from "./Whiteboard";

const NAME_KEY = "whiteboard:name";
const CLIENT_KEY = "whiteboard:clientId";
const OWNER_PREFIX = "whiteboard:owner:";
const OWNER_FRAGMENT = /^#owner=([A-Za-z0-9_-]{16,128})$/;

function read(store: () => Storage, key: string): string | null {
  try { return store().getItem(key); } catch { return null; }
}
function write(store: () => Storage, key: string, value: string) {
  try { store().setItem(key, value); } catch { /* storage unavailable, keep going without it */ }
}

/**
 * Reads the saved name, the per-tab client id and (for the creator of a board) the owner key,
 * and asks for a name if there is none. `viewId` means a read-only visit.
 */
export default function Board(props: { boardId?: string; viewId?: string; boardName: string }) {
  const { boardId, viewId, boardName } = props;
  const [ready, setReady] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [ownerKey, setOwnerKey] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let id = read(() => sessionStorage, CLIENT_KEY);
    if (!id) {
      id = newId();
      write(() => sessionStorage, CLIENT_KEY, id);
    }
    let owner: string | undefined;
    if (boardId) {
      // The creator arrives with the key in the URL fragment. Keep it, then remove it from the address bar.
      const fromUrl = OWNER_FRAGMENT.exec(window.location.hash)?.[1];
      if (fromUrl) {
        write(() => localStorage, OWNER_PREFIX + boardId, fromUrl);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      owner = fromUrl ?? read(() => localStorage, OWNER_PREFIX + boardId) ?? undefined;
    }
    const saved = nameSchema.safeParse(read(() => localStorage, NAME_KEY));
    // Storage only exists in the browser, so it can only be read after mount.
    /* eslint-disable react-hooks/set-state-in-effect */
    setClientId(id);
    setOwnerKey(owner);
    setName(saved.success ? saved.data : null);
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [boardId]);

  if (!ready) return <main className="p-6 text-slate-600">Loading...</main>;

  if (!name) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold">{boardName}</h1>
        {viewId && <p className="text-sm text-slate-600">You are opening a view-only link.</p>}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = nameSchema.safeParse(draft);
            if (!parsed.success) return setError("Enter a name of 1 to 30 characters.");
            write(() => localStorage, NAME_KEY, parsed.data);
            setName(parsed.data);
          }}
        >
          <label htmlFor="who" className="text-sm font-medium">Your name</label>
          <input
            id="who" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={30} autoFocus
            autoComplete="off" className="rounded border border-slate-300 bg-white px-3 py-2"
            aria-invalid={error ? true : undefined} aria-describedby={error ? "who-error" : undefined}
          />
          {error && <p id="who-error" role="alert" className="text-sm text-red-700">{error}</p>}
          <button className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700">Join board</button>
        </form>
      </main>
    );
  }

  return <Whiteboard boardId={boardId} viewId={viewId} boardName={boardName} name={name} clientId={clientId} ownerKey={ownerKey} />;
}
