export type BrowserRelayStatus = {
  enabled: boolean;
  paired: boolean;
  pairingToken?: string | null;
  relayPort?: number | null;
};
