import React, { useState, useRef, useEffect } from 'react';
import { X, Music, AlertCircle, Sparkles } from 'lucide-react';
import { resolveYouTubeTrack, type YouTubeMetadata } from '../lib/youtubeMetadata';
import { TurnstileWidget } from './TurnstileWidget';
import { getTurnstileSiteKey, verifyTurnstileToken } from '../lib/turnstile';

interface RequestSongModalProps {
  onClose: () => void;
  onSubmit: (urlOrId: string) => Promise<string | null>;
}

export const RequestSongModal: React.FC<RequestSongModalProps> = ({ onClose, onSubmit }) => {
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<YouTubeMetadata | null>(null);
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase C (docs/012): bot check token; null = widget not solved yet.
  const siteKey = getTurnstileSiteKey();
  const [tsToken, setTsToken] = useState<string | null>(null);
  const [tsResetSignal, setTsResetSignal] = useState(0);
  // Phase D (docs/013): debounce oEmbed (was: fetch per keystroke ≥11 chars,
  // leaking video IDs + letting slow responses overwrite newer previews).
  const debounceRef = useRef<number | null>(null);
  const resolveSeq = useRef(0);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const handleInputChange = (val: string) => {
    setInput(val);
    setError(null);
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const trimmed = val.trim();
    if (trimmed.length < 11) {
      resolveSeq.current++;
      setPreview(null);
      setResolving(false);
      return;
    }
    setResolving(true);
    const mySeq = ++resolveSeq.current;
    debounceRef.current = window.setTimeout(async () => {
      const meta = await resolveYouTubeTrack(trimmed);
      if (resolveSeq.current !== mySeq) return; // stale response: drop
      setResolving(false);
      setPreview(meta);
    }, 400);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    setSubmitting(true);
    setError(null);

    // Bot gate: when a site key is configured, the token must verify
    // server-side before the song touches the queue.
    if (siteKey) {
      if (!tsToken) {
        setError('Please complete the human verification first.');
        setSubmitting(false);
        return;
      }
      const human = await verifyTurnstileToken(tsToken);
      setTsToken(null);
      setTsResetSignal((n) => n + 1);
      if (!human) {
        setError('Verification failed. Please try again.');
        setSubmitting(false);
        return;
      }
    }

    const err = await onSubmit(input.trim());
    if (err) {
      setError(err);
      setSubmitting(false);
    } else {
      onClose();
    }
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="auth-modal glass-panel request-modal" onClick={(e) => e.stopPropagation()}>
        <button className="auth-close" onClick={onClose} title="Close">
          <X size={18} />
        </button>

        <div className="modal-header">
          <div className="modal-icon-badge">
            <Music size={20} color="var(--accent-color)" />
          </div>
          <div>
            <h3>Request a Song</h3>
            <p className="modal-subtitle">Add your favorite track to the room's upvote queue</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" style={{ marginTop: '16px' }}>
          <div className="form-group">
            <label className="form-label">YouTube URL or Video ID</label>
            <input
              type="text"
              placeholder="e.g. https://youtu.be/... or dQw4w9WgXcQ"
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              required
              autoFocus
            />
          </div>

          {resolving && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Sparkles size={14} className="spinning" />
              <span>Fetching track details...</span>
            </div>
          )}

          {preview && (
            <div className="request-preview-card glass-panel">
              <img src={preview.thumbnail} alt={preview.title} className="request-preview-thumb" />
              <div className="request-preview-info">
                <span className="request-preview-title">{preview.title}</span>
                <span className="request-preview-artist">{preview.artist}</span>
              </div>
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
              <TurnstileWidget siteKey={siteKey} action="request_song" resetSignal={tsResetSignal} onToken={setTsToken} />
            </div>
          )}

          <button type="submit" className="auth-submit" disabled={submitting || !input.trim() || resolving || (!!siteKey && !tsToken)}>
            {submitting ? 'Submitting request...' : 'Add to Queue'}
          </button>
        </form>
      </div>
    </div>
  );
};
