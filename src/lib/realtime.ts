import { io, type Socket } from 'socket.io-client';
import { insforge } from './insforge';

type Listener = (payload: unknown) => void;

class RealtimeClient {
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private connectCallbacks = new Set<() => void>();
  private disconnectCallbacks = new Set<() => void>();
  private channels = new Set<string>();
  private apiKey: string;
  private url: string;
  private useApiKeyFallback = false;
  private authed = false;
  // 020: true only when the last handshake used a real user JWT. The anon
  // project key authenticates fine as a *listener* (chat/queue/receive) but
  // host-only sync PUBLISH requires authenticated — see publishSync.

  constructor() {
    const url = import.meta.env.VITE_INSFORGE_URL;
    this.apiKey = import.meta.env.VITE_INSFORGE_ANON_KEY;
    if (!url || !this.apiKey) {
      throw new Error('Missing InsForge realtime configuration (VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY)');
    }
    this.url = url;
  }

  get isConnected() {
    return this.socket?.connected ?? false;
  }

  // H5: true when the socket runs without a user JWT (anon key or post-failure
  // fallback). Sync publishes must fail closed in this state (server RLS
  // requires authenticated) instead of silently sending as anonymous.
  get isDegraded() {
    return this.useApiKeyFallback || !this.authed;
  }

  private async buildAuth(): Promise<Record<string, string>> {
    // 020: the gateway accepts ONLY `token` (JWT or anon_ key). `apiKey` form
    // is rejected with "Invalid API key", which used to leave every signed-out
    // visitor stuck on "Connecting" forever. Verified live 2026-09-03.
    if (this.useApiKeyFallback) {
      this.authed = false;
      return { token: this.apiKey };
    }
    // Signed-in users authenticate with their JWT (required by host-only
    // publish policies); anonymous visitors use the project key as token.
    const userToken = await insforge.getHttpClient().getValidAccessToken().catch(() => null);
    this.authed = !!userToken;
    return { token: userToken ?? this.apiKey };
  }

  // Call after sign-in/sign-out so the next handshake uses fresh credentials.
  // Manual disconnect() never auto-reconnects, so reconnect explicitly.
  refreshAuth() {
    this.useApiKeyFallback = false;
    const socket = this.socket;
    if (!socket) return;
    socket.disconnect();
    socket.connect();
  }

  private dispatchFrom(socket: Socket) {
    // Persistent: resubscribe known channels on every (re)connect.
    socket.on('connect', () => {
      for (const channel of this.channels) {
        socket.emit('realtime:subscribe', { channel }, () => {});
      }
      // Client-side 'connect' is a local event (not visible to onAny),
      // so bridge it for consumers that need reconnect reconciliation.
      for (const cb of this.connectCallbacks) {
        try {
          cb();
        } catch (err) {
          console.error('realtime connect callback error', err);
        }
      }
    });
    socket.on('disconnect', () => {
      for (const cb of this.disconnectCallbacks) {
        try {
          cb();
        } catch (err) {
          console.error('realtime disconnect callback error', err);
        }
      }
    });
    socket.onAny((event, message) => {
      if (event === 'realtime:error' || event === 'presence:join' || event === 'presence:leave') return;
      const set = this.listeners.get(event);
      if (set) {
        for (const cb of set) {
          try {
            cb(message);
          } catch (err) {
            console.error('realtime listener error', err);
          }
        }
      }
    });
  }

  private handshake(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Realtime connection timed out'));
      }, 10000);

      const onConnect = () => {
        window.clearTimeout(timeout);
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        window.clearTimeout(timeout);
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
      };

      socket.on('connect', onConnect);
      socket.on('connect_error', onError);
    });
  }

  private spawn(): Socket {
    const socket = io(this.url, {
      transports: ['websocket'],
      reconnection: true,
      auth: (cb) => {
        this.buildAuth().then(
          (auth) => cb(auth),
          () => {
            this.authed = false;
            cb({ token: this.apiKey });
          },
        );
      },
    });
    this.dispatchFrom(socket);
    this.socket = socket;
    return socket;
  }

  async connect(): Promise<void> {
    if (this.socket?.connected) return;
    if (this.connecting) return this.connecting;

    const existing = this.socket;
    if (existing) {
      // Reconnecting after a drop: reuse the socket instead of duplicating.
      this.connecting = this.handshake(existing).finally(() => {
        this.connecting = null;
      });
      return this.connecting;
    }

    this.connecting = (async () => {
      try {
        await this.handshake(this.spawn());
      } catch (err) {
        const tokenNow = await insforge.getHttpClient().getValidAccessToken().catch(() => null);
        if (!this.useApiKeyFallback && tokenNow) {
          // JWT handshake rejected — retry with the anon project token so the
          // room still receives (listening works anonymously; sync broadcast
          // stays fail-closed via publishSync until re-authenticated).
          console.warn('Realtime token handshake failed, retrying with project key:', err);
          this.useApiKeyFallback = true;
          this.socket?.disconnect();
          this.socket = null;
          await this.handshake(this.spawn());
        } else {
          throw err;
        }
      }
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async subscribe(channel: string): Promise<{ ok: boolean; error?: { code?: string; message?: string } }> {
    await this.connect();
    if (!this.socket || !this.socket.connected) {
      return { ok: false, error: { message: 'not connected' } };
    }
    this.channels.add(channel);
    return new Promise((resolve) => {
      const timeout = window.setTimeout(
        () => resolve({ ok: false, error: { code: 'SUBSCRIBE_TIMEOUT', message: 'Subscription ack timed out' } }),
        8000,
      );
      this.socket!.emit(
        'realtime:subscribe',
        { channel },
        (response: { ok: boolean; error?: { code?: string; message?: string } }) => {
          window.clearTimeout(timeout);
          if (!response?.ok) {
            this.channels.delete(channel);
            console.warn(`Realtime subscribe rejected for "${channel}":`, response?.error);
          }
          resolve({ ok: !!response?.ok, error: response?.error });
        },
      );
    });
  }

  unsubscribe(channel: string) {
    this.channels.delete(channel);
    this.socket?.emit('realtime:unsubscribe', { channel });
  }

  publish(channel: string, event: string, payload: unknown) {
    if (!this.socket || !this.socket.connected) {
      throw new Error('Not connected to realtime server. Call connect() first.');
    }
    this.socket.emit('realtime:publish', { channel, event, payload });
  }

  // Fail-closed publish for host-only channels (sync). Throws when the socket
  // has no user JWT (anon listeners can receive but never broadcast sync —
  // server RLS requires authenticated). Chat/queue keep publish().
  publishSync(channel: string, event: string, payload: unknown) {
    if (!this.socket || !this.socket.connected) {
      throw new Error('Not connected to realtime server. Call connect() first.');
    }
    if (!this.authed) {
      throw new Error('Realtime auth degraded — sign in again to keep broadcasting.');
    }
    this.socket.emit('realtime:publish', { channel, event, payload });
  }

  on(event: string, cb: Listener) {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(cb);
    this.listeners.set(event, set);
  }

  off(event: string, cb: Listener) {
    this.listeners.get(event)?.delete(cb);
  }

  // Channel-aware dispatch (C1 defense-in-depth): routes only payloads whose
  // channel/room matches the subscribed channel, so a forged cross-room event
  // delivered under the same event name is dropped. Keeps `on` for compat.
  // Message shapes vary (InsForge may put channel in message.channel,
  // message.channelName, or only room_id in payload), so match leniently:
  // exact channel string wins; otherwise fall back to room-id containment.
  onChannel(channel: string, event: string, cb: (payload: unknown) => void) {
    const wrapped: Listener = (payload: unknown) => {
      const msg = payload as Record<string, unknown> | null | undefined;
      const inner = (msg?.['data'] ?? msg?.['payload'] ?? msg) as Record<string, unknown> | null | undefined;
      const claimedChannel =
        (typeof msg?.['channel'] === 'string' && (msg['channel'] as string)) ||
        (typeof msg?.['channelName'] === 'string' && (msg['channelName'] as string)) ||
        (typeof inner?.['channel'] === 'string' && (inner['channel'] as string)) ||
        null;
      if (claimedChannel) {
        if (claimedChannel !== channel) return;
      } else {
        // No channel envelope: require the payload's room_id (if present) to
        // belong to the subscribed channel, else drop. Payloads without any
        // room context are still delivered (server is the enforcer).
        const roomId = typeof inner?.['room_id'] === 'string' ? (inner['room_id'] as string) : null;
        if (roomId && !channel.includes(roomId)) return;
      }
      cb(payload);
    };
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(wrapped);
    this.listeners.set(event, set);
    // Return an unsubscribe fn for hook cleanup without tracking wrapper refs.
    return () => {
      this.listeners.get(event)?.delete(wrapped);
    };
  }

  // Fires on every (re)connect — including the very first one.
  onConnect(cb: () => void) {
    this.connectCallbacks.add(cb);
  }

  offConnect(cb: () => void) {
    this.connectCallbacks.delete(cb);
  }

  onDisconnect(cb: () => void) {
    this.disconnectCallbacks.add(cb);
  }

  offDisconnect(cb: () => void) {
    this.disconnectCallbacks.delete(cb);
  }
}

export const realtime = new RealtimeClient();
