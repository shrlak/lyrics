import { useEffect, useState } from 'react';
import { dismissToast, subscribeToasts, type Toast } from '../lib/utils/toast';

type DisplayedToast = Toast & { leaving?: boolean };

/**
 * Renders whatever's pushed via showToast() as a stack in the bottom-left
 * corner. Keeps a toast mounted for its exit animation instead of dropping
 * it the instant it leaves the source list, so it fades/slides away rather
 * than vanishing mid-frame.
 */
export default function ToastHost() {
  const [displayed, setDisplayed] = useState<DisplayedToast[]>([]);

  useEffect(
    () =>
      subscribeToasts((next) => {
        setDisplayed((prev) => {
          const nextIds = new Set(next.map((t) => t.id));
          const stillLeaving = prev.filter((t) => t.leaving && !nextIds.has(t.id));
          const newlyLeaving = prev
            .filter((t) => !t.leaving && !nextIds.has(t.id))
            .map((t) => ({ ...t, leaving: true }));
          return [...stillLeaving, ...newlyLeaving, ...next];
        });
      }),
    [],
  );

  if (displayed.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {displayed.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}${t.leaving ? ' toast-leaving' : ''}`}
          onAnimationEnd={() => {
            if (t.leaving) setDisplayed((prev) => prev.filter((d) => d.id !== t.id));
          }}
        >
          <span>{t.message}</span>
          <button onClick={() => dismissToast(t.id)} aria-label="닫기">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
