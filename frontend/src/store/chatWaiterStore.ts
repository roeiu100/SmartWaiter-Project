import { create } from "zustand";
import type { ChatMessage } from "../services/chatApi";

function defaultWelcomeMessages(): ChatMessage[] {
  return [
    {
      role: "assistant",
      content:
        "Hi — I'm your AI waiter. Ask about the menu or tell me what you'd like to order.",
    },
  ];
}

interface ChatWaiterState {
  messages: ChatMessage[];
  appendMessage: (msg: ChatMessage) => void;
  appendMessages: (msgs: ChatMessage[]) => void;
  replaceMessages: (msgs: ChatMessage[]) => void;
  resetToWelcome: () => void;
}

export const useChatWaiterStore = create<ChatWaiterState>((set) => ({
  messages: defaultWelcomeMessages(),

  appendMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  appendMessages: (msgs) =>
    set((s) => ({ messages: [...s.messages, ...msgs] })),

  replaceMessages: (msgs) => set({ messages: msgs }),

  resetToWelcome: () => set({ messages: defaultWelcomeMessages() }),
}));
