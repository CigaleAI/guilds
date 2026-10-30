import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { guildPath } from "./guilds";
import type {
  GroupChatState,
  GroupMessage,
  Notifications,
  GroupMessageInput,
} from "../types";

/**
 * Query keys of the group chat and the inbox. Identity is fixed for the page's life, so keys carry
 * no user or org.
 */
export const chatKeys = {
  chatState: (guildId: string) => ["guild", guildId, "group-chat", "state"] as const,
  chatMessages: (guildId: string) => ["guild", guildId, "group-chat", "messages"] as const,
  notifications: ["notifications"] as const,
};

export function useGroupChatState(guildId: string) {
  return useQuery({
    queryKey: chatKeys.chatState(guildId),
    queryFn: () => api<GroupChatState>(`${guildPath(guildId)}/group-chat`),
  });
}

/** The guild's whole public history, oldest first. */
export function useGroupMessages(guildId: string) {
  return useQuery({
    queryKey: chatKeys.chatMessages(guildId),
    queryFn: () => api<GroupMessage[]>(`${guildPath(guildId)}/group-chat/messages`),
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: chatKeys.notifications,
    queryFn: () => api<Notifications>("/api/notifications"),
  });
}

/** Reads every guild chat that tags this operator: their read cursor moves through each one. */
export function useMarkTagsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<Notifications>("/api/notifications/read", { method: "POST" }),
    onSuccess: (inbox) => {
      client.setQueryData(chatKeys.notifications, inbox);
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "guild" && query.queryKey[2] === "group-chat",
      });
    },
  });
}

/**
 * Posts to the group chat; `@name` in the text tags agents and operators. `interrupt` also stops
 * the group runs the message targets.
 */
export function usePostGroupMessage(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (message: GroupMessageInput) =>
      api<GroupMessage>(`${guildPath(guildId)}/group-chat/messages`, {
        method: "POST",
        body: message,
      }),
    onSuccess: (message) => {
      client.setQueryData<GroupMessage[]>(chatKeys.chatMessages(guildId), (messages) =>
        messages && !messages.some((known) => known.seq === message.seq)
          ? [...messages, message]
          : messages,
      );
      void client.invalidateQueries({ queryKey: chatKeys.chatState(guildId) });
    },
  });
}

/** Shows a cleared group chat: no messages, and the state the clear left, keeping the read marker. */
export function showClearedGroupChat(
  client: QueryClient,
  guildId: string,
  state: GroupChatState,
): void {
  client.setQueryData<GroupMessage[]>(chatKeys.chatMessages(guildId), []);
  client.setQueryData<GroupChatState>(chatKeys.chatState(guildId), (previous) => ({
    ...state,
    seen_through_seq: previous?.seen_through_seq ?? null,
  }));
}

/** Deletes every group chat message for everyone in the guild; for guild admins. */
export function useClearGroupChat(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<GroupChatState>(`${guildPath(guildId)}/group-chat/messages`, { method: "DELETE" }),
    onSuccess: (state) => showClearedGroupChat(client, guildId, state),
  });
}

/** Moves this operator's read marker forward; the server never moves it back. */
export function useMarkGroupChatRead(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (seq: number) =>
      api<{ seen_through_seq: number }>(`${guildPath(guildId)}/group-chat/read`, {
        method: "PUT",
        body: { seen_through_seq: seq },
      }),
    onSuccess: ({ seen_through_seq }) => {
      client.setQueryData<GroupChatState>(chatKeys.chatState(guildId), (state) =>
        state ? { ...state, seen_through_seq } : state,
      );
    },
  });
}

/** How many agent messages in a row the group chat takes before an operator must post. */
export function useSetMessageLimit(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (limit: number) =>
      api<GroupChatState>(`${guildPath(guildId)}/group-chat`, {
        method: "PUT",
        body: { agent_message_limit: limit },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.chatState(guildId) }),
  });
}
