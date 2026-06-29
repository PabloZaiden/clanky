/**
 * Shared hook for lazily fetching variants for one model in a workspace.
 */

import { useEffect, useState } from "react";
import { log } from "../lib/logger";
import { appFetch } from "../lib/public-path";

const modelVariantsCache = new Map<string, string[]>();
const modelVariantsRequests = new Map<string, Promise<string[]>>();

function getModelVariantsCacheKey(
  workspaceId: string,
  directory: string,
  modelID: string,
): string {
  return JSON.stringify([workspaceId, directory, modelID]);
}

function normalizeVariants(variants: string[] | undefined): string[] {
  return variants && variants.length > 0 ? variants : [""];
}

async function fetchModelVariantsForCache(
  workspaceId: string,
  directory: string,
  modelID: string,
): Promise<string[]> {
  const cacheKey = getModelVariantsCacheKey(workspaceId, directory, modelID);
  const cached = modelVariantsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const existingRequest = modelVariantsRequests.get(cacheKey);
  if (existingRequest) {
    return await existingRequest;
  }

  const request = (async () => {
    const params = new URLSearchParams({
      directory,
      workspaceId,
      modelID,
    });
    const response = await appFetch(`/api/models/variants?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch model variants: ${response.status}`);
    }
    const data = await response.json() as { variants?: string[] };
    const variants = normalizeVariants(data.variants);
    modelVariantsCache.set(cacheKey, variants);
    return variants;
  })();

  modelVariantsRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    modelVariantsRequests.delete(cacheKey);
  }
}

export interface UseModelVariantsOptions {
  directory: string | undefined;
  workspaceId: string | undefined;
  modelID: string | undefined;
  enabled?: boolean;
}

export interface UseModelVariantsResult {
  variants: string[];
  variantsLoading: boolean;
}

export function useModelVariants({
  directory,
  workspaceId,
  modelID,
  enabled = true,
}: UseModelVariantsOptions): UseModelVariantsResult {
  const [variants, setVariants] = useState<string[]>([]);
  const [variantsLoading, setVariantsLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !directory || !workspaceId || !modelID) {
      setVariants([]);
      setVariantsLoading(false);
      return;
    }

    const controller = new AbortController();
    const resolvedDirectory = directory;
    const resolvedWorkspaceId = workspaceId;
    const resolvedModelID = modelID;
    const cached = modelVariantsCache.get(
      getModelVariantsCacheKey(resolvedWorkspaceId, resolvedDirectory, resolvedModelID),
    );

    if (cached) {
      setVariants(cached);
      setVariantsLoading(false);
      return () => {
        controller.abort();
      };
    }

    async function fetchVariants() {
      setVariantsLoading(true);
      try {
        const data = await fetchModelVariantsForCache(
          resolvedWorkspaceId,
          resolvedDirectory,
          resolvedModelID,
        );
        if (controller.signal.aborted) {
          return;
        }
        setVariants(data);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        log.error("Failed to fetch model variants:", String(error));
        setVariants([]);
      } finally {
        if (!controller.signal.aborted) {
          setVariantsLoading(false);
        }
      }
    }

    void fetchVariants();

    return () => {
      controller.abort();
    };
  }, [directory, enabled, modelID, workspaceId]);

  return { variants, variantsLoading };
}
