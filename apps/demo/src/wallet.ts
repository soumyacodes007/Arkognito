// MetaMask on Tiramisu. Shared by the public and private Sketch App.
import { tiramisu } from "@arkiv-network/sdk/chains"
import type { Address } from "viem"
import "viem/window"

/** Both versions of the Sketch App write to the same project, so the observer can compare them. */
export const PROJECT = "arkognito-demo-sketch"

export const EXPLORER = "https://tiramisu.explorer.arkiv.network"

async function switchToTiramisu() {
  if (!window.ethereum) throw new Error("MetaMask is not installed")
  const chainId = `0x${tiramisu.id.toString(16)}`
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] })
  } catch (error) {
    if ((error as { code?: number })?.code !== 4902) throw error
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "Arkiv Tiramisu Testnet",
          nativeCurrency: tiramisu.nativeCurrency,
          rpcUrls: [...tiramisu.rpcUrls.default.http],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    })
  }
}

export async function connectWallet(): Promise<Address> {
  if (!window.ethereum) throw new Error("MetaMask is not installed")
  await switchToTiramisu()
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" })
  return account
}
