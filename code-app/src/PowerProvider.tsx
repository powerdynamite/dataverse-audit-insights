import { useEffect, useState, type ReactNode } from "react";
import { initialize } from "@microsoft/power-apps/app";

/**
 * Initializes the Power Apps SDK before rendering the app. When running inside
 * the Power Platform player this wires up connector auth + context. During local
 * `vite dev` initialize() resolves in a degraded mode and the app falls back to
 * direct Web API calls (see auditService).
 */
export function PowerProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    initialize()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e: unknown) => {
        // Local dev / outside the player: continue in fallback mode.
        console.warn("Power Apps SDK init failed; running in fallback mode.", e);
        if (!cancelled) {
          setReady(true);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <div className="app-loading">Connecting to Power Platform…</div>;
  }

  return (
    <>
      {error && (
        <div className="app-banner app-banner--warn">
          SDK fallback mode — using direct Web API. ({error})
        </div>
      )}
      {children}
    </>
  );
}
