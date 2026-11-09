import type { AttendanceActionState } from "@/modules/conversations/actions";

/** Resultado da última operação (mesmo visual do painel de módulos do admin). */
export function ActionFeedback({ state }: { state: AttendanceActionState }) {
  return (
    <div aria-live="polite">
      {state.status !== "idle" && (
        <p
          role={state.status === "error" ? "alert" : "status"}
          className={
            state.status === "error"
              ? "rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300"
              : "rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
          }
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
