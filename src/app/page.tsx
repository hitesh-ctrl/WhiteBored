import CreateBoardForm from "../components/CreateBoardForm";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold">Whiteboard</h1>
      <p className="text-center text-slate-600">
        Create a board, share the link, and draw together. Anyone with the link can join.
      </p>
      <CreateBoardForm />
    </main>
  );
}
