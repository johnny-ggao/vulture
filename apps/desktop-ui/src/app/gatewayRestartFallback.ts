/**
 * Retry-with-restart helpers for gateway calls that may 404 if the
 * gateway is mid-upgrade (route registered after the local UI started)
 * or temporarily unhealthy (503 / fetch failure).
 *
 * Each function:
 *   1. Tries the operation once.
 *   2. If the failure matches `isMissingRoute`, asks the Tauri host to
 *      restart the gateway, then polls /healthz until it answers.
 *   3. Retries the operation up to 30 times with 200ms backoff. Bails
 *      with the most recent error if every attempt fails.
 *
 * Lives in its own module so App.tsx is just orchestration glue, and so
 * the policy can be unit-tested or reused elsewhere without dragging the
 * whole shell along.
 */

import { invoke } from "@tauri-apps/api/core";

import { attachmentsApi } from "../api/attachments";
import type { ApiClient } from "../api/client";
import { skillsApi, type SkillListResponse } from "../api/skills";
import {
  delay,
  isGatewayRestarting,
  isMissingAttachmentRoute,
  isMissingSkillsRoute,
} from "./appHelpers";

/**
 * Generic retry-through-restart wrapper. The `isMissingRoute` predicate
 * captures the exact "this route doesn't exist yet" signature for the
 * specific feature, so retries only kick in when restart could plausibly
 * help (we don't want to mask validation errors).
 */
export async function withGatewayRestartForMissingRoute<T>(
  apiClient: ApiClient | null,
  run: () => Promise<T>,
  isMissingRoute: (cause: unknown) => boolean,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (!isMissingRoute(cause) || !apiClient) throw cause;
    await invoke("restart_gateway");
    let lastError: unknown = cause;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(200);
      try {
        await apiClient.get<{ ok: boolean }>("/healthz");
      } catch (healthCause) {
        lastError = healthCause;
        continue;
      }
      try {
        return await run();
      } catch (retryCause) {
        lastError = retryCause;
        if (isMissingRoute(retryCause) || isGatewayRestarting(retryCause)) {
          continue;
        }
        throw retryCause;
      }
    }
    throw lastError;
  }
}

/**
 * Upload attachments, retrying through a gateway restart if the
 * attachments route returns 404. Files upload in parallel — the whole
 * batch retries together so the gateway never sees a half-uploaded set.
 */
export async function uploadAttachmentsWithGatewayRestartFallback(
  apiClient: ApiClient | null,
  files: File[],
) {
  if (!apiClient || files.length === 0) return [];
  try {
    return await Promise.all(
      files.map((file) => attachmentsApi.upload(apiClient, file)),
    );
  } catch (cause) {
    if (!isMissingAttachmentRoute(cause)) throw cause;
    await invoke("restart_gateway");
    let lastError: unknown = cause;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(200);
      try {
        await apiClient.get<{ ok: boolean }>("/healthz");
      } catch (healthCause) {
        lastError = healthCause;
        continue;
      }
      try {
        return await Promise.all(
          files.map((file) => attachmentsApi.upload(apiClient, file)),
        );
      } catch (retryCause) {
        lastError = retryCause;
        if (
          isMissingAttachmentRoute(retryCause) ||
          isGatewayRestarting(retryCause)
        ) {
          continue;
        }
        throw retryCause;
      }
    }
    throw lastError;
  }
}

/** Skills list with the same retry-through-restart policy. */
export async function loadSkillsWithGatewayRestartFallback(
  apiClient: ApiClient | null,
  agentId: string,
): Promise<SkillListResponse> {
  if (!apiClient) throw new Error("API client is not ready");
  try {
    return await skillsApi.list(apiClient, agentId);
  } catch (cause) {
    if (!isMissingSkillsRoute(cause)) throw cause;
    await invoke("restart_gateway");
    let lastError: unknown = cause;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(200);
      try {
        await apiClient.get<{ ok: boolean }>("/healthz");
      } catch (healthCause) {
        lastError = healthCause;
        continue;
      }
      try {
        return await skillsApi.list(apiClient, agentId);
      } catch (retryCause) {
        lastError = retryCause;
        if (
          isMissingSkillsRoute(retryCause) ||
          isGatewayRestarting(retryCause)
        ) {
          continue;
        }
        throw retryCause;
      }
    }
    throw lastError;
  }
}
