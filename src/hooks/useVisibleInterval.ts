import { useEffect } from "react";

const pageHidden = () => document.visibilityState === "hidden";

// Calls `callback` every `delay` ms while the page is visible; `null` turns polling off. A hidden tab
// stops the timer, and becoming visible again refreshes once immediately and restarts it. A new
// callback or delay restarts the interval, like an effect that depends on them.
export function useVisibleInterval(callback: () => unknown, delay: number | null): void {
  useEffect(() => {
    if (delay === null) return;
    let timer: number | undefined;
    const start = () => { timer = window.setInterval(() => void callback(), delay); };
    const stop = () => { window.clearInterval(timer); timer = undefined; };
    const visibilityChange = () => {
      if (pageHidden()) stop();
      else if (timer === undefined) { void callback(); start(); }
    };
    if (!pageHidden()) start();
    document.addEventListener("visibilitychange", visibilityChange);
    return () => { stop(); document.removeEventListener("visibilitychange", visibilityChange); };
  }, [callback, delay]);
}
