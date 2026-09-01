import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus inside a modal while it is open, and puts it back where it came
 * from when the modal closes.
 *
 * Tab from the last control wraps to the first and Shift+Tab the other way, so the
 * scrimmed editor behind the dialog is never reachable by keyboard while the dialog is
 * up. If nothing inside has focus after mount (the dialog set no `autoFocus`), the first
 * control takes it — a dialog that opens with focus still on the button behind it is one
 * a keyboard user cannot find.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getAttribute('aria-hidden') !== 'true',
      );

    if (!root.contains(document.activeElement)) focusables()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      const outside = !root.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };

    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      // The control that opened the dialog is where a keyboard user expects to land next.
      if (opener && opener.isConnected) opener.focus();
    };
  }, [ref]);
}
