import { useState, useEffect, useCallback } from 'react';
import { insforge } from '../lib/insforge';
import { realtime } from '../lib/realtime';
import { getOrCreateSessionId, getMemberToken } from '../lib/session';

export interface ChatMessage {
  id: string | number;
  userId?: string | null;
  user: string;
  text: string;
  time: string;
  created_at?: string;
  room_id?: string;
}

export const MAX_MESSAGE_LENGTH = 500;

function formatTime(iso?: string) {
  return new Date(iso || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function useChatMessages(roomId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Load initial messages from database
  const fetchMessages = useCallback(async () => {
    try {
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      // C2: explicit columns (no select('*')) so RLS scoping + least data.
      let query = insforge.database
        .from('chat_messages')
        .select('id,user_id,user_name,message,created_at,room_id')
        .gte('created_at', thirtyMinsAgo);

      if (roomId) {
        query = query.eq('room_id', roomId);
      }

      const { data, error: dbError } = await query
        .order('created_at', { ascending: false })
        .limit(50);

      if (dbError) {
        console.warn('Initial chat_messages fetch notice:', dbError.message);
        return;
      }

      if (data && Array.isArray(data) && data.length > 0) {
        const formatted: ChatMessage[] = [...data].reverse().map((item: any) => ({
          id: item.id,
          userId: item.user_id,
          user: item.user_name || 'Anonymous',
          text: item.message || '',
          time: formatTime(item.created_at),
          created_at: item.created_at,
          room_id: item.room_id,
        }));
        setMessages(formatted);
      } else {
        setMessages([]);
      }
    } catch (err: any) {
      console.warn('Could not fetch initial chat_messages:', err?.message || err);
    }
  }, [roomId]);

  // Connect & subscribe to the room-scoped realtime channel.
  useEffect(() => {
    let isSubscribed = true;
    let offChannel: (() => void) | null = null;
    const channelName = roomId ? `room:${roomId}:chat` : 'chat_messages';
    const eventName = 'message';

    const handleIncomingEvent = (payload: any) => {
      if (!isSubscribed) return;

      const record = payload?.data || payload?.payload || payload;
      if (!record) return;

      // Filter by room if specified
      if (roomId && record.room_id && record.room_id !== roomId) return;

      // 039: server fan-out carries client_id so the sender's optimistic
      // message is reconciled (not duplicated).
      if (record.client_id) {
        let matched = false;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === record.client_id) {
              matched = true;
              return {
                ...m,
                id: record.id,
                userId: record.user_id ?? m.userId ?? null,
                user: record.user_name || m.user,
                text: typeof record.message === 'string' ? record.message : m.text,
                time: formatTime(record.created_at),
                created_at: record.created_at || m.created_at,
                room_id: record.room_id,
              };
            }
            return m;
          })
        );
        if (matched) return;
      }

      const newMsg: ChatMessage = {
        id: record.id,
        userId: record.user_id ?? null,
        user: record.user_name || 'Listener',
        text: typeof record.message === 'string' ? record.message : '',
        time: formatTime(record.created_at),
        created_at: record.created_at || new Date().toISOString(),
        room_id: record.room_id,
      };

      if (!newMsg.text || !newMsg.id) return;

      setMessages((prev) => {
        if (prev.some((m) => m.id === newMsg.id)) return prev;
        return [...prev, newMsg];
      });
    };

    async function initRealtime() {
      try {
        await realtime.connect();
        if (!isSubscribed) return;
        setIsConnected(true);

        const sub = await realtime.subscribe(channelName);
        if (sub && !sub.ok) {
          console.warn(`Realtime subscribe rejected for "${channelName}":`, sub.error);
        }
        // C1: channel-aware dispatch drops forged cross-room chat events.
        offChannel = realtime.onChannel(channelName, eventName, handleIncomingEvent);

        await fetchMessages();
      } catch (err: any) {
        console.warn('Realtime subscription setup notice:', err?.message || err);
        if (isSubscribed) {
          setError(err?.message || 'Failed to establish realtime connection');
        }
      }
    }

    const reconcileOnReconnect = async () => {
      if (!isSubscribed) return;
      setIsConnected(true);
      await fetchMessages();
    };

    const handleDisconnected = () => {
      if (isSubscribed) setIsConnected(false);
    };

    initRealtime();
    realtime.onConnect(reconcileOnReconnect);
    realtime.onDisconnect(handleDisconnected);

    return () => {
      isSubscribed = false;
      try {
        offChannel?.();
        realtime.offConnect(reconcileOnReconnect);
        realtime.offDisconnect(handleDisconnected);
        realtime.unsubscribe(channelName);
      } catch (err) {
        console.warn('Cleanup error:', err);
      }
    };
  }, [roomId, fetchMessages]);

  useEffect(() => {
    // Prune messages older than 30 minutes
    const interval = setInterval(() => {
      const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
      setMessages((prev) =>
        prev.filter((msg) => new Date(msg.created_at || Date.now()).getTime() > thirtyMinsAgo)
      );
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const sendMessage = async (
    text: string,
    user: string = 'Listener',
    userId?: string | null
  ) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH) return;

    // 039: temp id doubles as the server-echo dedupe key (client_id).
    const clientId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `temp-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const createdAt = new Date().toISOString();
    const optimisticMsg: ChatMessage = {
      id: clientId,
      userId: userId ?? null,
      user,
      text: trimmed,
      time: formatTime(createdAt),
      created_at: createdAt,
      room_id: roomId,
    };

    setMessages((prev) => [...prev, optimisticMsg]);

    // 039: chat goes through the post_chat RPC (membership-proof, caps,
    // server-side realtime fan-out). Direct table INSERT is revoked.
    try {
      const { data, error: rpcError } = await insforge.database.rpc('post_chat', {
        p_room_id: roomId ?? null,
        p_message: trimmed,
        p_user_name: user,
        p_session_id: getOrCreateSessionId(),
        p_member_token: roomId ? getMemberToken(roomId) : null,
        p_client_id: clientId,
      });

      if (rpcError || !data?.success) {
        console.warn('Chat send note:', rpcError?.message || data?.error);
        setMessages((prev) => prev.filter((m) => m.id !== clientId));
        return;
      }
      // Reconcile in case the realtime echo hasn't arrived yet (or never does).
      const row = data as any;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === clientId
            ? { ...m, id: row?.id ?? m.id, user: row?.user_name || m.user }
            : m
        )
      );
    } catch (dbErr) {
      console.warn('Chat send error:', dbErr);
      setMessages((prev) => prev.filter((m) => m.id !== clientId));
      return;
    }
  };

  return {
    messages,
    sendMessage,
    isConnected,
    error,
    refreshMessages: fetchMessages,
  };
}
