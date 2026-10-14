import React, { useState } from 'react';
import { Link } from 'react-router-dom';

// Developer Policies III.A.2: each API Client "must require users to agree to
// a privacy policy before users can access" its features. This gate blocks the
// app until the user explicitly agrees, records the acknowledgment locally,
// and links both our policies and YouTube's Terms (III.A.1).

const ACK_KEY = 'jam_legal_ack_v1';

function hasAcknowledged(): boolean {
  try {
    return window.localStorage.getItem(ACK_KEY) === '1';
  } catch {
    // Private-mode storage failures shouldn't lock anyone out forever, but we
    // still show the gate each load rather than silently skipping consent.
    return false;
  }
}

export const LegalGate: React.FC = () => {
  const [accepted, setAccepted] = useState<boolean>(() => hasAcknowledged());

  if (accepted) return null;

  const accept = () => {
    try {
      window.localStorage.setItem(ACK_KEY, '1');
    } catch {
      // Storage blocked: still let them in for this session.
    }
    setAccepted(true);
  };

  return (
    <div className="legal-gate" role="dialog" aria-modal="true" aria-labelledby="legal-gate-title">
      <div className="legal-gate-card glass-panel">
        <h2 id="legal-gate-title">Before you enter</h2>
        <p>
          JAM plays music through the official YouTube embedded player. By continuing you agree to
          our{' '}
          <Link to="/terms" onClick={accept}>
            Terms of Use
          </Link>{' '}
          and{' '}
          <Link to="/privacy" onClick={accept}>
            Privacy Policy</Link>
          , and you agree to be bound by the{' '}
          <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">
            YouTube Terms of Service
          </a>
          .
        </p>
        <button type="button" className="legal-gate-accept" onClick={accept}>
          I agree — enter JAM
        </button>
      </div>
    </div>
  );
};
