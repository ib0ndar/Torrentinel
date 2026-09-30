import { createContext, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

type DialogBaseOptions = {
  eyebrow: string; title: string; description: string; confirmLabel: string; tone?: "default" | "danger";
};
type DialogPromptOptions = DialogBaseOptions & {
  inputLabel: string; initialValue?: string; inputType?: "text" | "password";
  autoComplete?: string; minLength?: number; maxLength?: number;
};
type DialogRequest = (DialogBaseOptions & { kind: "confirm" } | DialogPromptOptions & { kind: "prompt" }) & {
  id: number; resolve: (value: boolean | string | null) => void;
};
type DialogApi = {
  confirm: (options: DialogBaseOptions) => Promise<boolean>;
  prompt: (options: DialogPromptOptions) => Promise<string | null>;
};
const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<DialogRequest[]>([]);
  const pending = useRef<DialogRequest[]>([]);
  const nextId = useRef(0);
  const enqueue = useCallback((request: DialogRequest) => {
    pending.current = [...pending.current, request];
    setRequests(pending.current);
  }, []);
  const confirm = useCallback((options: DialogBaseOptions) => new Promise<boolean>((resolve) => {
    enqueue({ ...options, id: nextId.current++, kind: "confirm", resolve: (value) => resolve(value === true) });
  }), [enqueue]);
  const prompt = useCallback((options: DialogPromptOptions) => new Promise<string | null>((resolve) => {
    enqueue({ ...options, id: nextId.current++, kind: "prompt", resolve: (value) => resolve(typeof value === "string" ? value : null) });
  }), [enqueue]);
  const settle = useCallback((request: DialogRequest, value: boolean | string | null) => {
    request.resolve(value);
    pending.current = pending.current.filter((item) => item !== request);
    setRequests(pending.current);
  }, []);
  useEffect(() => () => {
    for (const request of pending.current) request.resolve(request.kind === "confirm" ? false : null);
    pending.current = [];
  }, []);
  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);
  const request = requests[0];
  return <DialogContext.Provider value={api}>
    {children}
    {request && <AppDialog key={request.id} request={request} onCancel={() => settle(request, request.kind === "confirm" ? false : null)} onAccept={(value) => settle(request, value)} />}
  </DialogContext.Provider>;
}

export function useDialog() {
  const dialog = useContext(DialogContext);
  if (!dialog) throw new Error("useDialog must be used inside DialogProvider");
  return dialog;
}

function AppDialog({ request, onCancel, onAccept }: { request: DialogRequest; onCancel: () => void; onAccept: (value: boolean | string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.kind === "prompt" ? request.initialValue || "" : "");
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const tone = request.tone || "default";
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
      else confirmRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); return; }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")]
      .filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    onAccept(request.kind === "confirm" ? true : value);
  }
  return <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
    <div ref={dialogRef} className={`app-dialog app-dialog--${tone}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={handleKeyDown}>
      <form onSubmit={submit}>
        <button type="button" className="app-dialog__close" onClick={onCancel} aria-label={t("Close dialog")}><Icon name="close" size={17} /></button>
        <div className="app-dialog__body">
          <p className="app-dialog__eyebrow"><span />{request.eyebrow}</p>
          <h2 id={titleId}>{request.title}</h2>
          <p id={descriptionId} className="app-dialog__description">{request.description}</p>
          {request.kind === "prompt" && <label className="app-dialog__field">
            <span>{request.inputLabel}</span>
            <input ref={inputRef} type={request.inputType || "text"} value={value} onChange={(event) => setValue(event.target.value)} autoComplete={request.autoComplete} minLength={request.minLength} maxLength={request.maxLength} required />
            {request.minLength && <small>{t("At least {count} characters", { count: request.minLength })}</small>}
          </label>}
        </div>
        <div className="app-dialog__actions">
          <button type="button" className="button button--quiet" onClick={onCancel}>{t("Cancel")}</button>
          <button ref={confirmRef} className={`button ${tone === "danger" ? "button--danger-filled" : "button--primary"}`}>{request.confirmLabel}</button>
        </div>
      </form>
    </div>
  </div>;
}
