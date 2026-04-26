import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface RuntimeDescriptor {
  apiVersion: "v1";
  gateway: { port: number };
  shell: { port: number };
  token: string;
  pid: number;
  startedAt: string;
  shellVersion: string;
}

export function useRuntimeDescriptor() {
  const [data, setData] = useState<RuntimeDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<RuntimeDescriptor>("get_runtime_info")
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error };
}
