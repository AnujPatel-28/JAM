import React, { useState } from 'react';
import { X, Lock, Globe, Sparkles, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { insforge } from '../lib/insforge';
import { TurnstileWidget } from './TurnstileWidget';
import { getTurnstileSiteKey, verifyTurnstileTicket } from '../lib/turnstile';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface CreateRoomModalProps {
  onClose: () => void;
  onSuccess: (roomCode: string) => void;
}

export const CreateRoomModal: React.FC<CreateRoomModalProps> = ({ onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  // Phase C (docs/012): room-creation bot gate; inert when unconfigured.
  const siteKey = getTurnstileSiteKey();
  const [tsToken, setTsToken] = useState<string | null>(null);
  const [tsResetSignal, setTsResetSignal] = useState(0);
  const panelRef = useDialogA11y(onClose);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    if (isPrivate && password.trim().length < 8) {
      setError('Private room password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    setError(null);

    // Single-use human-proof for create_room_secure (042). Null when the
    // widget is disabled — the RPC rejects null tickets in prod.
    let ticket: string | null = null;

    if (siteKey) {
      if (!tsToken) {
        setError('Please complete the human verification first.');
        setLoading(false);
        return;
      }
      // 042: the ticket (not a boolean) is the proof — create_room_secure
      // consumes it server-side, so direct-RPC bots can't skip the check.
      // Token is single-use: reset the widget whatever happens next.
      const human = await verifyTurnstileTicket(tsToken, 'create_room');
      setTsToken(null);
      setTsResetSignal((n) => n + 1);
      if (!human.ok || !human.ticket) {
        setError('Verification failed. Please try again.');
        setLoading(false);
        return;
      }
      ticket = human.ticket;
    }

    try {
      const { data, error: rpcError } = await insforge.database.rpc('create_room_secure', {
        p_name: trimmedName,
        p_is_private: isPrivate,
        p_password: isPrivate ? password.trim() : null,
        p_description: description.trim() || null,
        p_turnstile_ticket: ticket,
      });

      if (rpcError) {
        setError(rpcError.message || 'Failed to create room.');
        return;
      }

      if (data?.success && data?.code) {
        onSuccess(data.code);
      } else {
        setError(data?.error || 'Could not create room.');
      }
    } catch (err: any) {
      setError(err?.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div
        className="auth-modal glass-panel create-room-modal"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-room-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="auth-close" onClick={onClose} title="Close" aria-label="Close dialog">
          <X size={18} />
        </button>

        <div className="modal-header">
          <div className="modal-icon-badge">
            <Sparkles size={20} color="var(--accent-color)" />
          </div>
          <div>
            <h3 id="create-room-title">Create a Room</h3>
            <p className="modal-subtitle">Start a listening party for up to 5 people</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" style={{ marginTop: '16px' }}>
          <div className="form-group">
            <label className="form-label" htmlFor="create-room-name">Room Name</label>
            <input
              id="create-room-name"
              type="text"
              placeholder="e.g. Midnight Lofi, Chill Beats"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={60}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="create-room-desc">Genre or Vibe (Optional)</label>
            <input
              id="create-room-desc"
              type="text"
              placeholder="e.g. Synthwave, Indie, Coding beats"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={50}
            />
          </div>

          <div className="privacy-toggle-group">
            <button
              type="button"
              className={`privacy-toggle-btn ${!isPrivate ? 'active' : ''}`}
              onClick={() => setIsPrivate(false)}
              aria-pressed={!isPrivate}
            >
              <Globe size={16} />
              <span>Public Room</span>
            </button>
            <button
              type="button"
              className={`privacy-toggle-btn ${isPrivate ? 'active' : ''}`}
              onClick={() => setIsPrivate(true)}
              aria-pressed={isPrivate}
            >
              <Lock size={16} />
              <span>Private Room</span>
            </button>
          </div>

          {isPrivate && (
            <div className="form-group" style={{ animation: 'fadeIn 0.2s ease-out' }}>
              <label className="form-label" htmlFor="create-room-password">Room Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="create-room-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter room password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required={isPrivate}
                  minLength={8}
                  autoComplete="new-password"
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
              <span className="form-hint">Min 8 characters. Anyone joining will need this password.</span>
            </div>
          )}

          {error && (
            <div className="auth-error">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          {siteKey && (
            <div className="form-group">
              <TurnstileWidget siteKey={siteKey} action="create_room" resetSignal={tsResetSignal} onToken={setTsToken} />
            </div>
          )}

          <button type="submit" className="auth-submit" disabled={loading || !name.trim() || (!!siteKey && !tsToken)}>
            {loading ? 'Creating room...' : 'Launch Room'}
          </button>
        </form>
      </div>
    </div>
  );
};
