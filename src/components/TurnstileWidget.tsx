import React, { useEffect, useRef } from 'react';

// Lightweight Cloudflare Turnstile widget (explicit render, managed mode).
// Why not @marsidev/react-turnstile: zero new deps; singleton script tag;
// compact managed widget avoids invisible-mode retry loops (SO 78351582).
// Tokens are single-use, 300s expiry — ALWAYS verified server-side via
// functions/verify-turnstile.ts, never trusted alone. See docs/012.

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
      reset: (id: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error('Turnstile script failed to load'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

interface Props {
  siteKey: string;
  onToken: (token: string | null) => void;
  /** Stable per-surface identifier, validated server-side (Spin contract). */
  action?: string;
  /**
   * Increment after each submit: tokens are single-use and the SPA stays
   * mounted, so the widget must mint a fresh token for the next attempt.
   */
  resetSignal?: number;
}

export const TurnstileWidget: React.FC<Props> = ({ siteKey, onToken, action, resetSignal }) => {
  const ref = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        await loadScript();
      } catch {
        return; // fail-open at widget layer; server verify still gates submit
      }
      if (cancelled || !ref.current || !window.turnstile) return;
      try {
        widgetId = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          ...(action ? { action } : {}),
          theme: 'auto',
          size: 'compact',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
          'timeout-callback': () => onTokenRef.current(null),
        });
        widgetIdRef.current = widgetId;
      } catch {
        // Widget render failure: leave null token; submit stays disabled.
      }
    })();
    return () => {
      cancelled = true;
      try {
        if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
      } catch {}
      widgetIdRef.current = null;
    };
  }, [siteKey, action]);

  // Fresh token per attempt (Spin single-use lifecycle).
  useEffect(() => {
    if (resetSignal === undefined) return;
    try {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    } catch {}
  }, [resetSignal]);

  return <div ref={ref} aria-label="Human verification" />;
};
