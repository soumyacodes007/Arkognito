import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"

export function arkivClients(rpcUrl: string, accessKey: string | undefined, privateKey: Hex) {
  const transport = () => http(rpcUrl, accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {})
  const publicClient = createPublicClient({ chain: tiramisu, transport: transport() })
  const walletClient = createWalletClient({ chain: tiramisu, transport: transport(), account: privateKeyToAccount(privateKey) })
  return { publicClient, walletClient, address: walletClient.account.address }
}

export type ArkivClients = ReturnType<typeof arkivClients>

/** One write at a time for this wallet: tx nonces and entity-key predictions both depend on it (R5). */
export class WriteQueue {
  #tail: Promise<unknown> = Promise.resolve()
  #pending = 0

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.#pending++
    const next = this.#tail.then(fn, fn).finally(() => this.#pending--)
    this.#tail = next.catch(() => undefined)
    return next
  }

  get pending() {
    return this.#pending
  }
}

/** Retries a read with exponential backoff; the SDK itself never retries. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4, baseMs = 500): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i))
    }
  }
  throw last
}
