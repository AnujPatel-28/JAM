import React, { useState, useEffect } from 'react';
import { Lock, X, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface PasswordPromptModalProps {
  roomName: string;
  roomCode: string;
  onClose: () => void;
  onSubmit: (password: string) => Promise<string | null>;
}

export const PasswordPromptModal: React.FC<PasswordPromptModalProps> = ({
  roomName,
  roomCode,
  onClose,
  onSubmit,
}) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Client-side spray UX (server pg_sleep is the real throttle): after 3
  // failures, cool down 10s. See docs/security-fixes/006-H3-passwords.md.
  const [failures, setFailures] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, setTick] = useState(0);
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const panelRef = useDialogA11y(onClose);

  // Tick so the cooldown button label counts down instead of freezing.
  useEffect(() => {
    if (cooldownLeft <= 0) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [cooldownLeft]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || loading || cooldownLeft > 0) return;

    setLoading(true);
    setError(null);

    const err = await onSubmit(password.trim());
    // Always release the button — on success the parent unmounts this modal,
    // on failure the error below explains what to fix.
    setLoading(false);
    if (err) {
      const next = failures + 1;
      setFailures(next);
      if (next >= 3) {
        setCooldownUntil(Date.now() + 10_000);
        setFailures(0);
      }
      setError(err);
    }
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div
        className="auth-modal glass-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-prompt-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="auth-close" onClick={onClose} title="Close" aria-label="Close dialog">
          <X size={18} />
        </button>

        <div className="modal-header">
          <div className="modal-icon-badge">
            <Lock size={20} color="var(--accent-color)" />
          </div>
          <div>
            <h3 id="password-prompt-title">Private Room</h3>
            <p className="modal-subtitle">
              Enter password for <strong style={{ color: 'var(--text-primary)' }}>{roomName}</strong> ({roomCode})
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" style={{ marginTop: '16px' }}>
          <div className="form-group">
            <label className="form-label" htmlFor="room-password">Password</label>
            <div style={{ position: 'relative' }}>
              <input
                id="room-password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter room password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
                className="input-with-toggle"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute',
                  right: '10px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  padding: 0,
                }}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="auth-error">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          <button type="submit" className="auth-submit" disabled={loading || !password.trim() || cooldownLeft > 0}>
            {loading ? 'Verifying...' : cooldownLeft > 0 ? `Try again in ${cooldownLeft}s` : 'Enter Room'}
          </button>
        </form>
      </div>
    </div>
  );
};
