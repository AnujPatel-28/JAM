import React from 'react';
import { Users, Lock, Radio, ArrowRight } from 'lucide-react';

export interface RoomListItem {
  id: string;
  name: string;
  code: string;
  is_private: boolean;
  max_members: number;
  description?: string | null;
  active_count: number;
  created_at?: string;
  // C2: host_id no longer fetched for the public directory (was leaking via
  // select('*')). Optional for backward-compat with detail views.
  host_id?: string;
}

interface RoomCardProps {
  room: RoomListItem;
  onJoin: (room: RoomListItem) => void;
}

export const RoomCard: React.FC<RoomCardProps> = ({ room, onJoin }) => {
  const isFull = room.active_count >= (room.max_members || 5);
  const ageMins = room.created_at ? Math.max(0, Math.round((Date.now() - new Date(room.created_at).getTime()) / 60000)) : null;
  const ageLabel = ageMins === null ? null : ageMins < 1 ? 'just now' : ageMins < 60 ? `${ageMins}m ago` : `${Math.floor(ageMins / 60)}h ${ageMins % 60}m ago`;
  const vibeLabel = isFull ? 'Room full' : room.active_count === 0 ? 'Quiet right now' : room.active_count <= 2 ? 'Getting going' : 'Lively';

  return (
    <article className={`room-card glass-panel ${isFull ? 'room-card-full' : ''}`}>
      <div className="room-card-header">
        <div className="room-card-title-group">
          <h3 className="room-card-title" title={room.name}>
            {room.name}
          </h3>
          <span className="room-meta-line">
            <span className="room-code-tag">{room.code}</span>
            {ageLabel && <span className="room-age">· {ageLabel}</span>}
          </span>
        </div>
        {room.is_private ? (
          <span className="privacy-badge private" title="Private Room - Password required">
            <Lock size={12} aria-hidden="true" /> Private
          </span>
        ) : (
          <span className="privacy-badge public" title="Public Room">
            <Radio size={12} aria-hidden="true" /> Live
          </span>
        )}
      </div>

      <p className="room-card-desc">
        {room.description || vibeLabel}
      </p>

      <div className="room-card-footer">
        <div className={`capacity-badge ${isFull ? 'full' : 'available'}`}>
          <Users size={14} aria-hidden="true" />
          <span>
            {room.active_count}/{room.max_members || 5} in room
          </span>
        </div>

        <button
          className={`room-join-btn ${isFull ? 'disabled' : ''}`}
          disabled={isFull}
          onClick={() => !isFull && onJoin(room)}
          aria-label={isFull ? `${room.name} is full` : `Join ${room.name} (${room.code})`}
        >
          <span>{isFull ? 'Full' : 'Join'}</span>
          {!isFull && <ArrowRight size={14} strokeWidth={2.5} aria-hidden="true" />}
        </button>
      </div>
    </article>
  );
};
