// Oblivious HTTP relay (R7, T3). Run by someone other than the relayers. It sees client IPs and
// encrypted blobs; relayers see requests but only this relay's IP. It keeps no logs, forwards no
// client headers, and only forwards to relayers announced in live `arkognito.relayer` heartbeats (or an
// explicit allowlist), so it cannot be used as an open proxy.
//
//   Run it with: tsx src/start.ts ohttp-relay   (or ROLE=ohttp-relay in Docker)
import { createServer } from "node:http"
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { heartbeatRelayers } from "arkognito"
import { http } from "viem"
import "./config"

const LIMIT = 128 * 1024

/** Loopback, private, link-local and unique-local hosts: never forwarded to unless allowLocal (SSRF). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0") return true
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")
}

export function startOhttpRelay(opts: {
  port: number
  rpcUrl?: string
  accessKey?: string
  /** Explicit allowlist. Without it, targets come from heartbeats and are verified. */
  targets?: string[]
  /** Allow http:// and private or loopback targets. Local development only. */
  allowLocal?: boolean
  log?: (m: string) => void
}) {
  const log = opts.log ?? ((m: string) => console.log(`[ohttp-relay] ${m}`))
  const reader = createPublicClient({
    chain: tiramisu,
    transport: http(opts.rpcUrl, opts.accessKey ? { fetchOptions: { headers: { "X-API-KEY": opts.accessKey } } } : {}),
  })
  const norm = (u: string) => u.replace(/\/$/, "")
  let allowed = new Set((opts.targets ?? []).map(norm))
  let refreshed = 0
  async function allowedTargets(): Promise<Set<string>> {
    if (opts.targets?.length) return allowed
    if (Date.now() - refreshed > 60_000) {
      try {
        // Anyone can publish a heartbeat naming any URL. Forward only to https targets on public
        // hosts that answer /v1/info with the heartbeat creator's address and the same gateway key.
        const candidates = (await heartbeatRelayers(reader)).filter((r) => r.ohttpKey)
        const ok = await Promise.all(
          candidates.map(async (hb) => {
            try {
              const u = new URL(hb.url)
              if (u.protocol !== "https:" && !(opts.allowLocal && u.protocol === "http:")) return undefined
              if (isPrivateHost(u.hostname) && !opts.allowLocal) return undefined
              const res = await fetch(`${norm(hb.url)}/v1/info`, { signal: AbortSignal.timeout(3000), redirect: "error" })
              const info = (await res.json()) as { address?: string; ohttpKey?: string }
              const same = info.address?.toLowerCase() === hb.address.toLowerCase() && info.ohttpKey?.toLowerCase() === hb.ohttpKey?.toLowerCase()
              return same ? norm(hb.url) : undefined
            } catch {
              return undefined
            }
          }),
        )
        allowed = new Set(ok.filter((u): u is string => !!u))
        refreshed = Date.now()
      } catch {
        // keep the last list
      }
    }
    return allowed
  }

  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-arkognito-target",
    "access-control-allow-methods": "POST, OPTIONS",
  }

  const server = createServer(async (req, res) => {
    const fail = (status: number, msg: string) => {
      res.writeHead(status, { "content-type": "text/plain", ...cors })
      res.end(msg)
    }
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors)
        return res.end()
      }
      const path = new URL(req.url ?? "/", "http://x").pathname
      if (req.method === "GET" && path === "/healthz") {
        res.writeHead(200, { "content-type": "application/json", ...cors })
        return res.end(JSON.stringify({ ok: true, role: "ohttp-relay", targets: (await allowedTargets()).size }))
      }
      if (req.method !== "POST" || path !== "/ohttp") return fail(404, "not found")
      const target = norm(String(req.headers["x-arkognito-target"] ?? ""))
      if (!(await allowedTargets()).has(target)) return fail(403, "unknown relayer")
      const chunks: Buffer[] = []
      let size = 0
      for await (const c of req) {
        size += c.length
        if (size > LIMIT) return fail(413, "too large")
        chunks.push(c as Buffer)
      }
      // Only the encrypted body is forwarded: no client address, no client headers.
      const upstream = await fetch(`${target}/v1/ohttp`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "message/ohttp-req" },
        body: Buffer.concat(chunks),
      })
      const body = Buffer.from(await upstream.arrayBuffer())
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "message/ohttp-res", ...cors })
      res.end(body)
    } catch {
      fail(502, "upstream failed")
    }
  })

  return {
    server,
    listen: () =>
      new Promise<void>((r) =>
        server.listen(opts.port, () => {
          log(`listening on :${opts.port} (${opts.targets?.length ? `${opts.targets.length} allowed relayers` : "relayers from heartbeats"})`)
          r()
        }),
      ),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
