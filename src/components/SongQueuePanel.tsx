import React, { useState } from 'react';
import { ThumbsUp, Play, Trash2, Plus, Music2 } from 'lucide-react';
import type { QueuedSong } from '../hooks/useRoomQueue';
import type { MusicTrack } from '../lib/providers/types';

interface SongQueuePanelProps {
  queue: QueuedSong[];
  isHost: boolean;
  sessionId: string;
  myQueuedCount: number;
  onOpenRequestModal: () => void;
  onToggleUpvote: (id: string) => void;
  onPlayQueuedSong: (track: MusicTrack, queueId: string) => void;
  onDismissSong: (queueId: string) => void;
}

export const SongQueuePanel: React.FC<SongQueuePanelProps> = ({
  queue,
  isHost,
  sessionId,
  myQueuedCount,
  onOpenRequestModal,
  onToggleUpvote,
  onPlayQueuedSong,
  onDismissSong,
}) => {
  const [armedId, setArmedId] = useState<string | null>(null);

  const handleDismiss = (id: string) => {
    if (armedId === id) {
      setArmedId(null);
      onDismissSong(id);
    } else {
      setArmedId(id);
    }
  };

  return (
    <div className="queue-panel">
      <div className="queue-actions-header">
        <button
          className="request-song-btn"
          onClick={onOpenRequestModal}
          title={myQueuedCount >= 3 ? 'You have 3 songs queued — wait for one to play' : 'Request a song (up to 3 at a time)'}
        >
          <Plus size={15} />
          <span>Request a Song ({myQueuedCount}/3)</span>
        </button>
      </div>

      <div className="queue-list">
        {queue.length === 0 ? (
          <div className="queue-empty-state">
            <Music2 size={36} color="var(--text-secondary)" />
            <h4>The queue is empty</h4>
            <p>
              {isHost
                ? 'Paste a YouTube link or video ID to queue up the next vibe!'
                : 'Request a song above, then upvote your favorites — the host plays the winners!'}
            </p>
          </div>
        ) : (
          queue.map((item, idx) => (
            <div
              key={item.id}
              className={`queue-item glass-panel${item.requested_by_session === sessionId ? ' own-request' : ''}`}
            >
              <div className="queue-rank">#{idx + 1}</div>

              <img
                src={item.album_art || `https://img.youtube.com/vi/${item.video_id}/hqdefault.jpg`}
                alt={item.title}
                className="queue-thumb"
              />

              <div className="queue-item-info">
                <span className="queue-title" title={item.title}>
                  {item.title}
                </span>
                <div className="queue-meta">
                  <span className="queue-artist">{item.artist || 'YouTube'}</span>
                  <span className="queue-requester">• by {item.requested_by_name}</span>
                </div>
              </div>

              <div className="queue-item-actions">
                {/* Upvote Button for all listeners */}
                <button
                  className={`upvote-btn ${item.has_voted ? 'voted' : ''}`}
                  onClick={() => onToggleUpvote(item.id)}
                  title={item.has_voted ? 'Remove upvote' : 'Upvote song'}
                  aria-label={item.has_voted ? `Remove upvote for ${item.title}` : `Upvote ${item.title}`}
                >
                  <ThumbsUp size={14} fill={item.has_voted ? 'currentColor' : 'none'} />
                  <span>{item.vote_count}</span>
                </button>

                {/* Host Moderation Controls */}
                {isHost && (
                  <div className="host-queue-controls">
                    <button
                      className="queue-play-btn"
                      onClick={() =>
                        onPlayQueuedSong(
                          {
                            id: item.video_id,
                            title: item.title,
                            artist: item.artist,
                            albumArt: item.album_art || `https://img.youtube.com/vi/${item.video_id}/hqdefault.jpg`,
                            provider: 'youtube',
                            url: `https://www.youtube.com/watch?v=${item.video_id}`,
                          },
                          item.id
                        )
                      }
                      title="Play track now (Host only)"
                      aria-label={`Play ${item.title} now`}
                    >
                      <Play size={13} fill="currentColor" />
                    </button>

                    <button
                      className={`queue-delete-btn${armedId === item.id ? ' armed' : ''}`}
                      onClick={() => handleDismiss(item.id)}
                      onBlur={() => setArmedId((a) => (a === item.id ? null : a))}
                      title={armedId === item.id ? 'Click again to confirm' : 'Dismiss track'}
                      aria-label={armedId === item.id ? `Confirm dismiss ${item.title}` : `Dismiss ${item.title}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
