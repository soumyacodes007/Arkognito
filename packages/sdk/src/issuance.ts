// The token-issuance request message, shared by the token client and the key vault.
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "viem"
import type { IssueRequest } from "./protocol.ts"

/** The message signed to ask for tokens. Includes a timestamp so a captured request cannot be replayed later. */
export function issuanceMessage(r: Pick<IssueRequest, "app" | "epoch" | "blinded">, ts: number) {
  const digest = bytesToHex(sha256(new TextEncoder().encode(r.blinded.join(","))))
  return `arkognito tokens v1\napp: ${r.app}\nday: ${r.epoch}\ncount: ${r.blinded.length}\nrequest: ${digest}\nts: ${ts}`
}
