import React, { useState, useEffect } from 'react';
import { X, Radio, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useDialogA11y } from '../hooks/useDialogA11y';

export type AuthModalMode = 'signin' | 'signup' | null;

interface AuthModalProps {
  mode: Exclude<AuthModalMode, null>;
  onClose: () => void;
  onSignIn: (email: string, password: string) => Promise<string | null>;
  onSignUp: (email: string, password: string, name: string) => Promise<string | null>;
  onVerify: (email: string, otp: string) => Promise<string | null>;
  onResend: (email: string) => Promise<string | null>;
  onRequestReset: (email: string) => Promise<string | null>;
  onVerifyReset: (email: string, code: string) => Promise<{ token: string } | { error: string }>;
  onConfirmReset: (resetToken: string, newPassword: string) => Promise<string | null>;
  onSwitchMode: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  mode,
  onClose,
  onSignIn,
  onSignUp,
  onVerify,
  onResend,
  onRequestReset,
  onVerifyReset,
  onConfirmReset,
  onSwitchMode,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  // 018: let users see what they typed (typo'd passwords are the #1
  // "can't sign in" cause). Resets when the modal closes/unmounts.
  const [showPassword, setShowPassword] = useState(false);
  // H5: client-side OTP guess limit (server lockout is the boundary).
  // After 5 bad codes, force a fresh code via resend.
  const [otpFailures, setOtpFailures] = useState(0);
  // Reset-password mechanism, one step at a time (server contract:
  // emailed CODE → exchange → one-time TOKEN → new password). Separate from
  // pendingEmail (signup verification) — the two OTP purposes never share state.
  const [resetView, setResetView] = useState<'auth' | 'forgot-email' | 'forgot-verify' | 'forgot-new'>('auth');
  const [resetEmail, setResetEmail] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetFailures, setResetFailures] = useState(0);
  const panelRef = useDialogA11y(onClose);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = window.setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendCooldown]);

  const handleResend = async () => {
    // Resend target depends on which OTP flow is active.
    const target = pendingEmail || resetEmail;
    if (!target || resendCooldown > 0) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const err = pendingEmail ? await onResend(target) : await onRequestReset(target);
      if (err) setError(err);
      else {
        setNotice('A new code has been sent.');
        setResendCooldown(60);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForgotSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Generic reply by design — never confirms whether the email exists.
      const err = await onRequestReset(email);
      if (err) {
        setError(err);
      } else {
        setResetEmail(email);
        setResetView('forgot-verify');
        setNotice(`If an account exists for ${email}, a 6-digit code is on its way.`);
        setResendCooldown(60);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForgotConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Step 1 of 2: verify the emailed code → one-time token.
      const out = await onVerifyReset(resetEmail, otp);
      if ('error' in out) {
        const next = resetFailures + 1;
        setResetFailures(next);
        if (next >= 5) {
          setResetFailures(0);
          setOtp('');
          setNotice('Too many incorrect codes. A fresh code is required — select Resend code.');
          setResendCooldown(60);
          setError(null);
        } else {
          setError(out.error);
        }
      } else {
        setResetFailures(0);
        setResetToken(out.token);
        setOtp('');
        setResetView('forgot-new');
        setNotice('Code verified. Choose a new password.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForgotSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetToken) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Step 2 of 2: token + new password. The server does NOT create a
      // session here (message-only reply), so route back to sign in.
      const err = await onConfirmReset(resetToken, newPassword);
      if (err) {
        setError(err);
      } else {
        setResetView('auth');
        setResetToken(null);
        setResetEmail(null);
        setNewPassword('');
        setOtp('');
        setNotice('Password updated! Sign in with your new password.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (pendingEmail) {
        const err = await onVerify(pendingEmail, otp);
        if (err) {
          const next = otpFailures + 1;
          setOtpFailures(next);
          if (next >= 5) {
            setOtpFailures(0);
            setOtp('');
            setNotice('Too many incorrect codes. A fresh code is required — select Resend code.');
            setResendCooldown(60);
            setError(null);
          } else {
            setError(err);
          }
        }
        else {
          setOtpFailures(0);
          onClose();
        }
      } else if (mode === 'signin') {
        const err = await onSignIn(email, password);
        if (!err) {
          onClose();
        } else if (/verif/i.test(err)) {
          setPendingEmail(email);
          setNotice('Your email is not verified yet. Enter the code below or request a new one.');
          setResendCooldown(60);
        } else {
          setError(err);
        }
      } else {
        const err = await onSignUp(email, password, name);
        if (err) setError(err);
        else {
          // 018: verification IS required — say so explicitly (previously the
          // modal flipped to OTP mode with no "check your inbox" message).
          setPendingEmail(email);
          setNotice(`Account created! We sent a 6-digit verification code to ${email} — enter it below to finish signing in.`);
          setResendCooldown(60);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div
        className="auth-modal glass-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="auth-close" onClick={onClose} title="Close" aria-label="Close dialog">
          <X size={16} />
        </button>

        <h3 id="auth-modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <Radio size={18} color="var(--accent-color)" />
          {pendingEmail
            ? 'Verify your email'
            : resetView !== 'auth'
              ? 'Reset your password'
              : mode === 'signin'
                ? 'Sign in as Host'
                : 'Create a host account'}
        </h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
          {pendingEmail
            ? `Enter the 6-digit code sent to ${pendingEmail}.`
            : resetView === 'forgot-email'
              ? 'Enter your account email — we’ll send a 6-digit reset code.'
              : resetView === 'forgot-verify'
                ? `Enter the code sent to ${resetEmail}. Codes expire after about 10 minutes.`
                : resetView === 'forgot-new'
                  ? 'Code verified. Choose a new password to finish signing in.'
                  : 'Only the authenticated room owner can control playback.'}
        </p>

        {resetView === 'forgot-email' ? (
          <form onSubmit={handleForgotSend} className="auth-form">
            <input
              type="email"
              placeholder="Email"
              aria-label="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            {error && (
              <div className="auth-error">
                <AlertCircle size={14} />
                {error}
              </div>
            )}
            {notice && !error && (
              <div style={{ fontSize: '0.75rem', color: 'var(--success-color)', marginBottom: '8px' }}>
                {notice}
              </div>
            )}
            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? 'Please wait...' : 'Send reset code'}
            </button>
            <button type="button" onClick={() => { setResetView('auth'); setError(null); setNotice(null); }} className="auth-link-btn">
              Back to sign in
            </button>
          </form>
        ) : resetView === 'forgot-verify' ? (
          <form onSubmit={handleForgotConfirm} className="auth-form">
            <input
              type="text"
              inputMode="numeric"
              placeholder="123456"
              aria-label="Verification code"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              required
              maxLength={6}
              autoFocus
            />
            {error && (
              <div className="auth-error">
                <AlertCircle size={14} />
                {error}
              </div>
            )}
            {notice && !error && (
              <div style={{ fontSize: '0.75rem', color: 'var(--success-color)', marginBottom: '8px' }}>
                {notice}
              </div>
            )}
            <button type="submit" className="auth-submit" disabled={busy || !otp.trim()}>
              {busy ? 'Please wait...' : 'Verify code'}
            </button>
            <button
              type="button"
              onClick={handleResend}
              disabled={busy || resendCooldown > 0}
              className="auth-link-btn"
            >
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s (old code stops working)` : 'Resend code'}
            </button>
          </form>
        ) : resetView === 'forgot-new' ? (
          <form onSubmit={handleForgotSetPassword} className="auth-form">
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="New password (min 6 characters)"
                aria-label="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={6}
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
            {error && (
              <div className="auth-error">
                <AlertCircle size={14} />
                {error}
              </div>
            )}
            {notice && !error && (
              <div style={{ fontSize: '0.75rem', color: 'var(--success-color)', marginBottom: '8px' }}>
                {notice}
              </div>
            )}
            <button type="submit" className="auth-submit" disabled={busy || newPassword.length < 6}>
              {busy ? 'Please wait...' : 'Set new password & sign in'}
            </button>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="auth-form">
          {!pendingEmail && (
            <>
              {mode === 'signup' && (
                <input
                  type="text"
                  placeholder="Display name"
                  aria-label="Display name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={1}
                />
              )}
              <input
                type="email"
                placeholder="Email"
                aria-label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Password"
                  aria-label="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
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
            </>
          )}
          {pendingEmail && (
            <input
              type="text"
              inputMode="numeric"
              placeholder="123456"
              aria-label="Verification code"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              required
              maxLength={6}
              autoFocus
            />
          )}

          {error && (
            <div className="auth-error">
              <AlertCircle size={14} />
              {error}
            </div>
          )}
          {notice && !error && (
            <div style={{ fontSize: '0.75rem', color: 'var(--success-color)', marginBottom: '8px' }}>
              {notice}
            </div>
          )}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy
              ? 'Please wait...'
              : pendingEmail
                ? 'Verify & Sign In'
                : mode === 'signin'
                  ? 'Sign In'
                  : 'Sign Up'}
          </button>

          {pendingEmail && (
            <button
              type="button"
              onClick={handleResend}
              disabled={busy || resendCooldown > 0}
              style={{
                marginTop: '8px',
                background: 'none',
                border: 'none',
                color: resendCooldown > 0 ? 'var(--text-secondary)' : 'var(--accent-color)',
                fontSize: '0.78rem',
                cursor: resendCooldown > 0 ? 'default' : 'pointer',
                textDecoration: 'underline',
              }}
            >
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
            </button>
          )}

          {/* Mode switch + forgot password (no dead ends for newcomers) */}
          {!pendingEmail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px', alignItems: 'center' }}>
              <button type="button" onClick={onSwitchMode} className="auth-link-btn">
                {mode === 'signin' ? 'New here? Create a host account' : 'Have an account? Sign in'}
              </button>
              {mode === 'signin' && (
                <button
                  type="button"
                  onClick={() => { setResetView('forgot-email'); setError(null); setNotice(null); }}
                  className="auth-link-btn"
                >
                  Forgot password?
                </button>
              )}
            </div>
          )}
        </form>
        )}
      </div>
    </div>
  );
};
