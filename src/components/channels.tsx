"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CircleCheck, CircleAlert, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { addChannel, removeShow, type ChannelState } from "@/app/admin/shows/actions";
import { btn, input } from "./ui";

/** Paste a YouTube channel link or @handle; the server resolves it and starts collecting. */
export function AddChannelForm() {
  const [state, action, pending] = useActionState<ChannelState, FormData>(addChannel, {});
  // React resets the uncontrolled input after the action finishes.
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">YouTube channel link or @handle</span>
          <svg viewBox="0 0 24 24" aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3">
            <path fill="currentColor" d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8ZM10 15V9l5.2 3Z" />
          </svg>
          <input name="input" required disabled={pending} autoComplete="off" spellCheck={false}
            placeholder="youtube.com/@channel or @handle"
            className={`${input} w-full pl-9`} />
        </label>
        <button type="submit" disabled={pending} aria-busy={pending} className={btn.primary}>
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
          {pending ? "Finding channel…" : "Add to radar"}
        </button>
      </div>
      {state.message && (
        <p aria-live="polite" className={`flex items-start gap-1.5 text-sm ${state.ok ? "text-good" : "text-bad"}`}>
          {state.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
          {state.message}
        </p>
      )}
    </form>
  );
}

function RemoveSubmit({ name }: { name: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-label={`Remove ${name}`} title={`Remove ${name}`}
      className="grid size-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-bad-soft hover:text-bad disabled:opacity-60">
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" strokeWidth={1.75} />}
    </button>
  );
}

/** Deletes the show and its collected episodes after a confirm. */
export function RemoveShowButton({ id, name, episodes }: { id: string; name: string; episodes: number }) {
  return (
    <form action={removeShow} onSubmit={(e) => {
      const what = episodes ? ` and its ${episodes} collected ${episodes === 1 ? "item" : "items"}` : "";
      if (!confirm(`Remove ${name}${what} from the radar? This can't be undone.`)) e.preventDefault();
    }}>
      <input type="hidden" name="id" value={id} />
      <RemoveSubmit name={name} />
    </form>
  );
}
