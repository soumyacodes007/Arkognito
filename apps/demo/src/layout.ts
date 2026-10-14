// Page chrome shared by every demo page: top bar with the live Tiramisu block, tabs, footer, and a
// counter of what the wallet was asked to do (signatures vs transactions).
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
import "viem/window"
import { EXPLORER } from "./wallet"

export type PageKey = "home" | "public" | "private" | "observer" | "wallet"

const TABS: [PageKey, string, string][] = [
  ["home", "Overview", "/"],
  ["public", "Public app", "/sketch-public.html"],
  ["private", "Private app", "/sketch-private.html"],
  ["observer", "Observer", "/observer.html"],
  ["wallet", "Wallet check", "/determinism.html"],
]

const REPO = "https://github.com/soumyacodes007/Arkognito"

export const reader = createPublicClient({ chain: tiramisu, transport: http() })

export const short = (a: string, n = 4) => `${a.slice(0, 2 + n)}…${a.slice(-n)}`
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
export const explorer = {
  address: (a: string) => `${EXPLORER}/address/${a}`,
  tx: (h: string) => `${EXPLORER}/tx/${h}`,
  entity: (k: string) => `${EXPLORER}/entity/${k}`,
}
export const extLink = (href: string, label: string, cls = "ext") =>
  `<a class="${cls}" href="${href}" target="_blank" rel="noopener">${label}</a>`

/** Small line icons (24px grid, stroke = currentColor). */
export const icon = {
  logo: `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor"/><path d="M7 16.5 12 6.5l5 10" fill="none" stroke="var(--bg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="13.3" r="1.4" fill="var(--bg)"/></svg>`,
  github: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>`,
  ext: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  info: `<svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
  pen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M16 7l2.5 2.5M18.5 4.5 21 7"/></svg>`,
  layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>`,
}

/** Mounts the top bar, tabs and footer around the page's <main>. */
export function mountChrome(page: PageKey, crumb?: string) {
  const header = document.createElement("header")
  header.className = "topbar"
  header.innerHTML = `
    <div class="topbar-inner">
      <div class="topbar-row">
        <a class="brand" href="/">${icon.logo}<span>Arkognito</span></a>
        ${crumb ? `<span class="crumb-sep hide-sm">/</span><span class="crumb hide-sm">${esc(crumb)}</span>` : ""}
        <span class="spacer"></span>
        <a class="pill" href="${EXPLORER}" target="_blank" rel="noopener" title="Arkiv Tiramisu testnet, live">
          <span class="dot" id="net-dot"></span><span class="hide-sm">Tiramisu</span><span class="mono" id="net-block">…</span>
        </a>
        <a class="icon-link" href="${REPO}" target="_blank" rel="noopener" aria-label="Source on GitHub">${icon.github}</a>
      </div>
      <nav class="tabs" aria-label="Demo pages">
        ${TABS.map(([k, label, href]) => `<a href="${href}"${k === page ? ` aria-current="page"` : ""}>${label}</a>`).join("")}
      </nav>
    </div>`
  document.body.prepend(header)

  const footer = document.createElement("footer")
  footer.className = "foot"
  footer.innerHTML = `
    <span>Arkognito · MIT</span>
    <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>
    <a href="${EXPLORER}" target="_blank" rel="noopener">Arkiv explorer</a>
    <span class="spacer"></span>
    <span>Tiramisu testnet · all data is synthetic</span>`
  document.body.append(footer)

  const blockEl = header.querySelector<HTMLElement>("#net-block")!
  const dot = header.querySelector<HTMLElement>("#net-dot")!
  const tick = async () => {
    try {
      const b = await reader.getBlockNumber()
      blockEl.textContent = `#${b.toLocaleString("en-US")}`
      dot.classList.add("live")
    } catch {
      dot.classList.remove("live")
    }
  }
  void tick()
  setInterval(() => document.visibilityState === "visible" && void tick(), 4000)
}

export type PromptCount = { signatures: number; transactions: number }

/**
 * Counts what the wallet is asked to approve, by watching requests to window.ethereum. Display only:
 * it never changes a request.
 */
export function watchWalletPrompts(onChange: (c: PromptCount) => void): PromptCount {
  const count: PromptCount = { signatures: 0, transactions: 0 }
  const eth = window.ethereum as unknown as { request: (a: { method: string }) => Promise<unknown> } | undefined
  if (!eth) return count
  const original = eth.request.bind(eth)
  try {
    eth.request = (args: { method: string }) => {
      if (/^(eth_signTypedData|personal_sign|eth_sign$)/.test(args.method)) count.signatures++
      else if (args.method === "eth_sendTransaction") count.transactions++
      else return original(args)
      onChange({ ...count })
      return original(args)
    }
  } catch {
    // provider object is frozen: no counter
  }
  return count
}
