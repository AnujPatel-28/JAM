import React, { useEffect, useRef } from 'react';
import YouTube from 'react-youtube';
import type { YouTubeProps } from 'react-youtube';

interface YouTubePlayerProps {
  playerProps: YouTubeProps;
}

function hardenIframes(root: ParentNode) {
  root.querySelectorAll('iframe').forEach((frame) => {
    frame.setAttribute('allow', 'accelerometer; autoplay; encrypted-media; picture-in-picture');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  });
}

// The player is ALWAYS rendered visibly. YouTube's RMF requires a viewport of
// at least 200x200, and Developer Policies III.I.9 bans "background players"
// (players not displayed on the screen the user is viewing) — the old 1px
// offscreen/audio-only hack violated both. Album art and extras live around
// this element, never instead of it.
export const YouTubePlayer: React.FC<YouTubePlayerProps> = ({ playerProps }) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 022: least-privilege iframe attrs. react-youtube + the YT IFrame API own
  // the <iframe> (created async after onReady), so observe and harden whatever
  // appears. sandbox would break playback, so allow+referrerpolicy only.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    hardenIframes(el);
    const obs = new MutationObserver(() => hardenIframes(el));
    obs.observe(el, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={wrapRef}
      className="youtube-embed-wrapper"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 200,
        minWidth: 200,
        overflow: 'hidden',
        borderRadius: 'inherit',
      }}
    >
      <YouTube
        {...playerProps}
        className="youtube-iframe-container"
        iframeClassName="youtube-iframe-element"
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
};
