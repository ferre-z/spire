import type { SpireApi } from "../shared/api";

declare global {
  interface Window {
    spire: SpireApi;
  }
}

export {};
