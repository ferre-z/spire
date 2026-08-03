import { useCallback, useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useDialogFocus({
  containerRef,
  initialFocusRef,
  onClose,
}: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): { readonly disableFocusRestore: () => void } {
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);

  useEffect(() => {
    const activeElement = document.activeElement;
    openerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    const container = containerRef.current;
    if (!container) return;
    const focusableElements = (): HTMLElement[] =>
      [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    (initialFocusRef?.current ?? focusableElements()[0] ?? container).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        container.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      if (restoreFocusRef.current) openerRef.current?.focus();
    };
  }, [containerRef, initialFocusRef, onClose]);

  const disableFocusRestore = useCallback(() => {
    restoreFocusRef.current = false;
  }, []);
  return { disableFocusRestore };
}
