import { useId, useRef } from "react";
import { Icon } from "./Icon";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useI18n } from "../i18n";

const SHORTCUTS: ReadonlyArray<[key: string, label: string]> = [
  ["/", "Search the collection (Monitor)"], ["j", "Next row"], ["k", "Previous row"], ["Enter", "Open the focused row"],
  ["a", "Add a subscription (Monitor)"], ["?", "Show these shortcuts"], ["Esc", "Close a dialog or panel"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null), doneRef = useRef<HTMLButtonElement>(null), titleId = useId(), descriptionId = useId();
  useFocusTrap(dialogRef, () => doneRef.current?.focus());
  return <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div ref={dialogRef} className="app-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <button type="button" className="app-dialog__close" onClick={onClose} aria-label={t("Close dialog")}><Icon name="close" size={17} /></button>
      <div className="app-dialog__body">
        <p className="app-dialog__eyebrow"><span />{t("Help")}</p>
        <h2 id={titleId}>{t("Keyboard shortcuts")}</h2>
        <p id={descriptionId} className="app-dialog__description">{t("Shortcuts work on Monitor and Activity while no text field has focus.")}</p>
        <dl className="shortcut-list">{SHORTCUTS.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{t(label)}</dd></div>)}</dl>
      </div>
      <div className="app-dialog__actions"><button ref={doneRef} type="button" className="button button--primary" onClick={onClose}>{t("Close")}</button></div>
    </div>
  </div>;
}
