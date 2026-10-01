export class MediaProviderError extends Error {
  constructor(message: string, readonly submission: "not-submitted" | "rejected" | "unknown", readonly httpStatus?: number, readonly resultUnknown = false, readonly remoteId?: string) {
    super(message);
    this.name = "MediaProviderError";
  }
}
