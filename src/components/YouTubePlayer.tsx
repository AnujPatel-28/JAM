import React, { useEffect, useRef } from 'react';
import YouTube from 'react-youtube';
import type { YouTubeProps } from 'react-youtube';

interface YouTubePlayerProps {
  playerProps: YouTubeProps;
  showVideo?: boolean;
}

function hardenIframes(root: ParentNode) {
  root.querySelectorAll('iframe').forEach((frame) => {
    frame.setAttribute('allow', 'accelerometer; autoplay; encrypted-media; picture-in-picture');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  });
}

export const YouTubePlayer: React.FC<YouTubePlayerProps> = ({ playerProps, showVideo = false }) => {
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
        position: showVideo ? 'relative' : 'absolute',
        width: showVideo ? '100%' : '1px',
        height: showVideo ? '100%' : '1px',
        top: showVideo ? 'auto' : '-9999px',
        left: showVideo ? 'auto' : '-9999px',
        opacity: showVideo ? 1 : 0,
        pointerEvents: showVideo ? 'auto' : 'none',
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
