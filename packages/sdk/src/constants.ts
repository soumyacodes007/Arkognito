/** Tiramisu, the Arkiv testnet. Mixed into the derivation message so keys never carry across chains (K6). */
export const TIRAMISU_CHAIN_ID = 7738577

/** Project attribute for Arkognito's own entities (issuer keys, spent list, relayer heartbeats). */
export const ARKOGNITO_PROJECT = "arkognito-7f3k"

/** Arkiv block time on Tiramisu, in seconds. */
export const BLOCK_TIME_SECONDS = 2

/** Expiry buckets in seconds (F1): 1 hour, 1 day, 7 days, 30 days, 90 days. */
export const EXPIRY_BUCKETS = [3600, 86_400, 604_800, 2_592_000, 7_776_000] as const

/** Envelope size buckets in bytes (F2). A record above the largest bucket is refused (X3). */
export const PAD_BUCKETS = [512, 1024, 4096, 16_384] as const

/** Envelope format version. */
export const ENVELOPE_VERSION = 1

/** Content type of every Arkognito record. The app's own content type travels inside the envelope. */
export const ENVELOPE_CONTENT_TYPE = "application/json"
