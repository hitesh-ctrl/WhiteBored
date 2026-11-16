"use client";

import { useActionState } from "react";
import { createBoard, type CreateBoardState } from "../app/actions";

export default function CreateBoardForm() {
  const [state, action, pending] = useActionState<CreateBoardState, FormData>(createBoard, {});
  return (
    <form action={action} className="flex w-full max-w-md flex-col gap-3">
      <label htmlFor="name" className="text-sm font-medium">Board name</label>
      <input
        id="name" name="name" required maxLength={30} autoComplete="off"
        className="rounded border border-slate-300 bg-white px-3 py-2"
        aria-describedby={state.error ? "name-error" : undefined}
      />
      {state.error && <p id="name-error" role="alert" className="text-sm text-red-700">{state.error}</p>}
      <button
        disabled={pending}
        className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {pending ? "Creating..." : "Create board"}
      </button>
    </form>
  );
}
