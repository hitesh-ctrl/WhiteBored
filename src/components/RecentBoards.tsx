"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RECENT_KEY, parseRecent, type Recent } from "../lib/recent";

/** Boards this browser opened before. Read after mount because storage only exists in the browser. */
export default function RecentBoards() {
  const [items, setItems] = useState<Recent[]>([]);
  useEffect(() => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(RECENT_KEY); } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(parseRecent(raw));
  }, []);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="recent-title" className="w-full max-w-md">
      <h2 id="recent-title" className="mb-2 text-sm font-medium text-slate-600">Recent boards</h2>
      <ul className="flex flex-col gap-1">
        {items.map((r) => (
          <li key={`${r.kind}:${r.id}`}>
            <Link
              href={r.kind === "view" ? `/view/${r.id}` : `/board/${r.id}`}
              className="flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-2 hover:bg-slate-100"
            >
              <span>{r.name}</span>
              {r.kind === "view" && <span className="text-xs text-slate-500">view only</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
