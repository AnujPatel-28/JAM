import { useState, useEffect, useCallback } from 'react';
import { insforge } from '../lib/insforge';
import { realtime } from '../lib/realtime';
import { rotateSessionId } from '../lib/session';

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
}

interface UseAuthResult {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string, name: string) => Promise<string | null>;
  verifyEmail: (email: string, otp: string) => Promise<string | null>;
  resendVerification: (email: string) => Promise<string | null>;
  requestPasswordReset: (email: string) => Promise<string | null>;
  verifyResetCode: (email: string, code: string) => Promise<{ token: string } | { error: string }>;
  confirmPasswordReset: (resetToken: string, newPassword: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

function toAuthUser(raw: any): AuthUser | null {
  if (!raw?.id) return null;
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name || raw.profile?.name || raw.user_metadata?.name,
  };
}

// H5: generic auth errors — never confirm whether an email is registered.
// Backend messages like "user not found" vs "wrong password" become one string.
function mapAuthError(message: string | undefined | null): string {
  const msg = (message || '').toLowerCase();
  if (/verif|otp|code|expired/.test(msg)) return 'Invalid or expired verification code.';
  if (/user.*not.*found|no.*user|not.*exist|invalid.*(email|password|credential)|wrong.*password|password.*incorrect|unauthorized/i.test(msg)) {
    return 'Invalid email or password.';
  }
  // 022: generic signup message — confirming "already exists" lets attackers
  // enumerate registered emails. The product copy stays friendly instead.
  if (/already.*(exist|register|taken)|duplicate/i.test(msg)) return 'Check your email to continue — we sent a verification code if this is a new account.';
  if (/rate|too many|throttl|locked/i.test(msg)) return 'Too many attempts. Please wait and try again.';
  return 'Authentication failed. Please try again.';
}

export function useAuth(): UseAuthResult {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await insforge.auth.getCurrentUser();
        if (cancelled) return;
        setUser(toAuthUser(data?.user));
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mobile keyboards/autofill love trailing spaces + capital first letters.
  // Emails are case-insensitive (RFC 5321), so normalize before every call —
  // otherwise "Anuj@Gmail.com " 401s against the stored lowercase address.
  // Passwords are NEVER trimmed (spaces can be intentional).
  const cleanEmail = (email: string) => email.trim().toLowerCase();

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await insforge.auth.signInWithPassword({ email: cleanEmail(email), password });
    if (error) return mapAuthError(error.message);
    setUser(toAuthUser(data?.user));
    // H5: socket handshake caches credentials — reconnect with the fresh JWT
    // so host-only sync publishes are authorized (and stop using anon fallback).
    realtime.refreshAuth();
    return null;
  }, []);

  const signUp = useCallback(async (email: string, password: string, name: string) => {
    const { data, error } = await insforge.auth.signUp({ email: cleanEmail(email), password, name });
    if (error) return mapAuthError(error.message);
    // Backend requires email verification (code method). The user is only
    // signed in after verifyEmail() succeeds.
    if (data?.requireEmailVerification) return null;
    setUser(toAuthUser(data?.user));
    realtime.refreshAuth();
    return null;
  }, []);

  const verifyEmail = useCallback(async (email: string, otp: string) => {
    const { data, error } = await insforge.auth.verifyEmail({ email: cleanEmail(email), otp });
    if (error) return mapAuthError(error.message);
    setUser(toAuthUser(data?.user));
    realtime.refreshAuth();
    return null;
  }, []);

  const resendVerification = useCallback(async (email: string) => {
    const { error } = await insforge.auth.resendVerificationEmail({ email: cleanEmail(email) });
    if (error) return mapAuthError(error.message);
    return null;
  }, []);

  // Reset-password mechanism (code method, mirrors email verification).
  // Correct server flow (docs.insforge.dev): the emailed 6-digit CODE is
  // NOT the reset credential — it must first be exchanged for a one-time
  // TOKEN, which is then passed as `otp` to resetPassword. Sending the code
  // directly as otp always 400s ("Invalid or expired verification token").
  // Step 1: send the 6-digit code. Generic reply — never confirm registration.
  const requestPasswordReset = useCallback(async (email: string) => {
    const { error } = await insforge.auth.sendResetPasswordEmail({ email: cleanEmail(email) });
    if (error) return mapAuthError(error.message);
    return null;
  }, []);

  // Step 2: verify the code FIRST → one-time reset token (or error string).
  const verifyResetCode = useCallback(async (email: string, code: string): Promise<{ token: string } | { error: string }> => {
    const { data, error } = await insforge.auth.exchangeResetPasswordToken({
      email: cleanEmail(email),
      code: code.trim(),
    });
    if (error) return { error: mapAuthError(error.message) };
    const token =
      (data as any)?.token ?? (data as any)?.resetToken ?? (data as any)?.otp ?? null;
    if (typeof token !== 'string' || !token) return { error: 'Invalid or expired verification code.' };
    return { token };
  }, []);

  // Step 3: token + new password → signed in on success.
  const confirmPasswordReset = useCallback(async (resetToken: string, newPassword: string) => {
    if (newPassword.length < 6) return 'Password must be at least 6 characters.';
    const { data, error } = await insforge.auth.resetPassword({ newPassword, otp: resetToken });
    if (error) return mapAuthError(error.message);
    setUser(toAuthUser((data as any)?.user));
    realtime.refreshAuth();
    return null;
  }, []);

  const signOut = useCallback(async () => {
    // 022: full presence/secret cleanup — old code left the room seat (ghost
    // until the 45s timeout), member tokens + room passwords in memory, the
    // old session id, and the socket on the stale JWT.
    try {
      await insforge.auth.signOut();
    } finally {
      rotateSessionId(); // clears tokens/passwords + mints a fresh session id
      setUser(null);
      // Drop the old JWT from the socket immediately (stale-token reuse).
      realtime.refreshAuth();
    }
  }, []);

  return { user, loading, signIn, signUp, verifyEmail, resendVerification, requestPasswordReset, verifyResetCode, confirmPasswordReset, signOut };
}
