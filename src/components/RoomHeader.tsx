import React, { useState, useEffect } from 'react';
import { ArrowLeft, Copy, Check, Users, Lock, Radio, LogOut, Clock, AlertTriangle } from 'lucide-react';
import { YouTubeIcon } from './Icons';

export interface ActiveMember {
  session_id: string;
  display_name: string;
  role: string;
  joined_at: string;
  is_active: boolean;
}

interface RoomHeaderProps {
  roomName: string;
  roomCode: string;
  isPrivate: boolean;
  isHost: boolean;
  activeMembers: ActiveMember[];
  userDisplayName: string;
  userEmail?: string;
  expiresAt?: string;
  onLeave: () => void;
  onSignOut?: () => void;
  showToast: (msg: string) => void;
}

export const RoomHeader: React.FC<RoomHeaderProps> = ({
  roomName,
  roomCode,
  isPrivate,
  isHost,
  activeMembers,
  userDisplayName,
  userEmail,
  expiresAt,
  onLeave,
  onSignOut,
  showToast,
}) => {
  const [copied, setCopied] = useState(false);
  const [showMembersDropdown, setShowMembersDropdown] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string>('');
  const [isNearExpiry, setIsNearExpiry] = useState(false);

  useEffect(() => {
    if (!expiresAt) return;
    const calculateTime = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft('Expired');
        setIsNearExpiry(true);
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setIsNearExpiry(diff < 15 * 60 * 1000); // under 15 mins
      setTimeLeft(hours > 0 ? `${hours}h ${mins}m` : `${mins}m`);
    };

    calculateTime();
    const interval = setInterval(calculateTime, 30000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const handleCopyLink = async () => {
    const inviteUrl = `${window.location.origin}/room/${roomCode}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      showToast('Invite link copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast(inviteUrl);
    }
  };

  const memberCount = activeMembers.length;

  return (
    <header className="header glass-panel in-room-header">
      <div className="header-left">
        <button className="back-lobby-btn" onClick={onLeave} title="Return to Lobby" aria-label="Return to Lobby">
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Lobby</span>
        </button>

        <div className="room-identity">
          <div className="room-title-line">
            <h2 className="header-room-name">{roomName}</h2>
            {isPrivate && (
              <span className="privacy-badge private" title="Private Room">
                <Lock size={12} />
              </span>
            )}
          </div>

          <button className="room-code-pill" onClick={handleCopyLink} title="Click to copy invite link">
            <span className="pill-code">{roomCode}</span>
            {copied ? <Check size={13} color="var(--success-color)" /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      <div className="header-right">
        {/* 24-Hour Expiration Countdown */}
        {timeLeft && (
          <div
            className={`expiry-pill ${isNearExpiry ? 'warning' : ''}`}
            title="Room and all data auto-purge after 24 hours"
          >
            {isNearExpiry ? <AlertTriangle size={13} /> : <Clock size={13} />}
            <span>{timeLeft} left</span>
          </div>
        )}

        {/* Live Members Capacity Pill */}
        <div className="members-indicator-wrapper">
          <button
            className="members-count-pill"
            onClick={() => setShowMembersDropdown(!showMembersDropdown)}
            title="Click to view active listeners"
          >
            <Users size={14} />
            <span>{memberCount}/5 In Room</span>
          </button>

          {showMembersDropdown && (
            <div className="members-dropdown glass-panel">
              <div className="dropdown-title">Active Listeners ({memberCount}/5)</div>
              <ul className="members-list">
                {activeMembers.map((m) => (
                  <li key={m.session_id} className="member-item">
                    <div className="member-dot" />
                    <span className="member-name">{m.display_name}</span>
                    {m.role === 'host' && <span className="member-role-badge">Host</span>}
                    {m.display_name === userDisplayName && <span className="member-role-badge you-badge">you</span>}
                  </li>
                ))}
                {activeMembers.length === 0 && (
                  <li className="member-item empty">Syncing listeners...</li>
                )}
              </ul>
            </div>
          )}
        </div>

        {isHost ? (
          <div className="provider-badge host-mode-badge">
            <YouTubeIcon size={16} />
            <span>Host Mode</span>
            <Radio size={12} color="var(--success-color)" />
          </div>
        ) : (
          <div className="provider-badge listener-mode-badge" title="The host runs playback — you shape the queue">
            <span>Listener</span>
          </div>
        )}

        {/* User Identity */}
        <div className="user-profile-pill" title={userEmail || userDisplayName}>
          {isHost && <span className="host-dot" title="You are hosting" />}
          <span className="user-display">{userDisplayName}</span>
          {onSignOut && (
            <button className="header-signout-btn" onClick={onSignOut} title="Sign Out">
              <LogOut size={14} />
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
