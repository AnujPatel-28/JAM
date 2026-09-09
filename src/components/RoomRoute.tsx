import { Suspense, lazy } from 'react';

// Room route is the heavy one (YouTube player, sockets, queue hooks) —
// split it so the lobby lands fast and room code loads on join.
const RoomPage = lazy(() =>
  import('../pages/RoomPage').then((m) => ({ default: m.RoomPage })),
);

export function RoomRoute() {
  return (
    <Suspense
      fallback={
        <div className="room-barrier-container">
          <div className="spinner" />
          <p style={{ marginTop: '16px', color: 'var(--text-secondary)' }}>Loading room...</p>
        </div>
      }
    >
      <RoomPage />
    </Suspense>
  );
}
