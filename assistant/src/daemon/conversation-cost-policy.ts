import type { LLMCallSite } from "../config/schemas/llm.js";
import type { InjectionMode } from "./conversation-runtime-assembly.js";

type ChatType = string | null | undefined;

export interface DirectChatCostPolicyInput {
  callSite: LLMCallSite;
  channelName?: string | null;
  chatType?: ChatType;
  commandIntent?: unknown;
  isSubagent?: boolean;
  overrideProfile?: string | null;
}

export interface DirectChatCostPolicy {
  leanDirectChat: boolean;
  generateTitle: boolean;
  runMemoryRetrieval: boolean;
  injectWorkspace: boolean;
  initialInjectionMode: InjectionMode;
}

const DIRECT_CHAT_CHANNELS = new Set(["telegram", "whatsapp"]);
const GROUP_CHAT_TYPES = new Set(["group", "supergroup", "channel"]);
const DIRECT_CHAT_CALL_SITES = new Set<LLMCallSite>(["mainAgent", "callAgent"]);

export function resolveDirectChatCostPolicy(
  input: DirectChatCostPolicyInput,
): DirectChatCostPolicy {
  const leanDirectChat = shouldUseLeanDirectChatMode(input);
  return {
    leanDirectChat,
    generateTitle: !leanDirectChat,
    runMemoryRetrieval: !leanDirectChat,
    injectWorkspace: !leanDirectChat,
    initialInjectionMode: leanDirectChat ? "minimal" : "full",
  };
}

export function shouldUseLeanDirectChatMode(
  input: DirectChatCostPolicyInput,
): boolean {
  if (!DIRECT_CHAT_CALL_SITES.has(input.callSite)) return false;
  if (input.isSubagent) return false;
  if (input.commandIntent != null) return false;
  if (isEscalatedProfile(input.overrideProfile)) return false;

  const channelName = input.channelName?.toLowerCase();
  if (!channelName || !DIRECT_CHAT_CHANNELS.has(channelName)) return false;

  const chatType = input.chatType?.toLowerCase();
  if (chatType && GROUP_CHAT_TYPES.has(chatType)) return false;

  return true;
}

function isEscalatedProfile(profile: string | null | undefined): boolean {
  return profile != null && profile !== "cost-optimized";
}
