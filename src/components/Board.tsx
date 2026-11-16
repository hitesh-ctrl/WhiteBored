"use client";

import { useEffect, useState } from "react";
import { newId } from "../lib/ids";
import { nameSchema } from "../shared/protocol";
import Whiteboard from "./Whiteboard";

const NAME_KEY = "whiteboard:name";
const CLIENT_KEY = "whiteboard:clientId";

function read(store: () => Storage, key: string): string | null {
  try { return store().getItem(key); } catch { return null; }
}
function write(store: () => Storage, key: string, value: string) {
  try { store().setItem(key, value); } catch { /* storage unavailable, keep going without it */ }
}

/** Reads the saved name and the per-tab client id, asks for a name if there is none. */
export default function Board({ boardId, boardName }: { boardId: string; boardName: string }) {
  const [ready, setReady] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let id = read(() => sessionStorage, CLIENT_KEY);
    if (!id) {
      id = newId();
      write(() => sessionStorage, CLIENT_KEY, id);
    }
    const saved = nameSchema.safeParse(read(() => localStorage, NAME_KEY));
    // Storage only exists in the browser, so it can only be read after mount.
    /* eslint-disable react-hooks/set-state-in-effect */
    setClientId(id);
    setName(saved.success ? saved.data : null);
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  if (!ready) return <main className="p-6 text-slate-600">Loading...</main>;

  if (!name) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold">{boardName}</h1>
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
          />
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <button className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700">Join board</button>
        </form>
      </main>
    );
  }

  return <Whiteboard boardId={boardId} boardName={boardName} name={name} clientId={clientId} />;
}
