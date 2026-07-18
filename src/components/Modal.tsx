import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

interface Props {
  title?: string;
  /** Wider layout for score images */
  wide?: boolean;
  /** Near-fullscreen layout for the split conti/editor view */
  full?: boolean;
  onClose: () => void;
  children: ReactNode;
}

// Every close path (backdrop, ✕, Escape) plays the reverse of the open
// animation before actually unmounting, so the sheet/dialog always leaves
// the way it arrived instead of vanishing mid-motion.
export default function Modal({ title, wide, full, onClose, children }: Props) {
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setClosing(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className={`modal-overlay${closing ? ' modal-overlay-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      onClick={() => setClosing(true)}
    >
      <div
        className={`modal${wide ? ' modal-wide' : ''}${full ? ' modal-full' : ''}${closing ? ' modal-closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onClose();
        }}
      >
        <div className="modal-header">
          {title ? <h3>{title}</h3> : <span />}
          <button type="button" className="modal-close" aria-label="닫기" onClick={() => setClosing(true)}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
