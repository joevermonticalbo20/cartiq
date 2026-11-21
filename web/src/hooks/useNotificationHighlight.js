import { useEffect, useState } from "react";

const HIGHLIGHT_MS = 3600;

export default function useNotificationHighlight(target, ready) {
  const [activeTarget, setActiveTarget] = useState(null);

  useEffect(() => {
    if (!target || !ready) return undefined;
    const element = Array.from(
      document.querySelectorAll("[data-notification-target]"),
    ).find((node) => node.dataset.notificationTarget === target);
    if (!element) return undefined;

    const startTimeout = setTimeout(() => {
      setActiveTarget(target);
      element.scrollIntoView?.({ behavior: "smooth", block: "center" });
    }, 0);
    const endTimeout = setTimeout(() => {
      setActiveTarget((current) => current === target ? null : current);
    }, HIGHLIGHT_MS);
    return () => {
      clearTimeout(startTimeout);
      clearTimeout(endTimeout);
    };
  }, [target, ready]);

  return ready && activeTarget === target ? activeTarget : null;
}
