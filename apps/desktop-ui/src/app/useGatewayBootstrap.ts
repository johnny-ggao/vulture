import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { agentsApi, type Agent } from "../api/agents";
import type { ApiClient } from "../api/client";
import { profileApi } from "../api/profile";
import { FALLBACK_TOOL_CATALOG, toolsApi, type ToolCatalogGroup } from "../api/tools";
import { delay, isMissingToolsRoute, type ProfileView } from "./appHelpers";

export interface UseGatewayBootstrapOptions {
  apiClient: ApiClient | null;
  refetchConversations: () => Promise<void> | void;
}

export interface UseGatewayBootstrapResult {
  profile: ProfileView | null;
  setProfile: Dispatch<SetStateAction<ProfileView | null>>;
  agents: Agent[];
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  toolCatalog: ToolCatalogGroup[];
  setToolCatalog: Dispatch<SetStateAction<ToolCatalogGroup[]>>;
  selectedAgentId: string;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  loadGatewayState(expectedProfileId?: string): Promise<boolean>;
}

export function useGatewayBootstrap(
  opts: UseGatewayBootstrapOptions,
): UseGatewayBootstrapResult {
  const { apiClient, refetchConversations } = opts;
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogGroup[]>(FALLBACK_TOOL_CATALOG);
  const [selectedAgentId, setSelectedAgentId] = useState("");

  const loadGatewayState = useCallback(
    async (expectedProfileId?: string): Promise<boolean> => {
      if (!apiClient) return false;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          const [profileResult, agentList] = await Promise.all([
            profileApi.get(apiClient),
            agentsApi.list(apiClient),
          ]);
          if (expectedProfileId && profileResult.id !== expectedProfileId) {
            throw new Error(`gateway still on profile ${profileResult.id}`);
          }
          setProfile({
            id: profileResult.id,
            name: profileResult.name,
            activeAgentId: profileResult.activeAgentId ?? "",
          });
          setAgents(agentList);
          try {
            const catalog = await toolsApi.catalog(apiClient);
            setToolCatalog(catalog.length > 0 ? catalog : FALLBACK_TOOL_CATALOG);
          } catch (catalogCause) {
            if (!isMissingToolsRoute(catalogCause)) throw catalogCause;
            setToolCatalog(FALLBACK_TOOL_CATALOG);
          }
          setSelectedAgentId(profileResult.activeAgentId || agentList[0]?.id || "");
          void refetchConversations();
          return true;
        } catch (cause) {
          lastError = cause;
          await delay(200);
        }
      }
      console.error("Failed to load gateway state", lastError);
      return false;
    },
    [apiClient, refetchConversations],
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!apiClient) return;
      await loadGatewayState();
      if (!mounted) return;
    })();
    return () => {
      mounted = false;
    };
  }, [apiClient, loadGatewayState]);

  return {
    profile,
    setProfile,
    agents,
    setAgents,
    toolCatalog,
    setToolCatalog,
    selectedAgentId,
    setSelectedAgentId,
    loadGatewayState,
  };
}
