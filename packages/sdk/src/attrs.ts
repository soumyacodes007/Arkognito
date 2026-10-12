// Typed attributes: a canonical string for signing, and a JSON wire form for the relayer API.
// Both sides normalise through the SDK's own `toValue`, so a value written as `5` and read back as
// `{ type: "i32", value: 5 }` canonicalise identically.
import type { AttributeInputs, Attributes } from "@arkiv-network/sdk"
import { addr, bool, bytes32, dec, i32, key, str, toValue, u256, u64 } from "@arkiv-network/sdk/attr"

export type WireValue = { type: string; value: string | number | boolean }
export type WireAttributes = Record<string, WireValue>

const HEX_TYPES = new Set(["addr", "key", "bytes32"])

function normalise(attrs: AttributeInputs | Attributes): [string, string, string][] {
  return Object.entries(attrs)
    .map(([name, input]): [string, string, string] => {
      const v = toValue(input as Parameters<typeof toValue>[0], name)
      const raw = String(v.value)
      return [name, v.type, HEX_TYPES.has(v.type) ? raw.toLowerCase() : raw]
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/**
 * Attribute names the Tiramisu node actually accepts. Stricter than the SDK's own validator: the
 * node rejects uppercase letters (see arkiv/friction.md), and one bad name reverts a whole batch,
 * failing every other user's record in it.
 */
export function nameProblem(name: string): string | undefined {
  if (!/^[a-z][a-z0-9._-]*$/.test(name)) return `attribute name "${name}" must be lowercase letters, digits, ".", "-" or "_", starting with a letter`
  if (name.includes("--")) return `attribute name "${name}" must not contain "--"`
  if (new TextEncoder().encode(name).length > 32) return `attribute name "${name}" is longer than 32 bytes`
  return undefined
}

export function assertNodeSafeNames(attrs: AttributeInputs | WireAttributes | undefined) {
  for (const name of Object.keys(attrs ?? {})) {
    const p = nameProblem(name)
    if (p) throw new Error(p)
  }
}

/** Deterministic text form of a set of attributes, used inside the envelope signature. */
export function canonicalAttributes(attrs: AttributeInputs | Attributes | undefined): string {
  return JSON.stringify(normalise(attrs ?? {}))
}

/** Attributes as plain JSON for the relayer API (bigints travel as strings). */
export function toWire(attrs: AttributeInputs | undefined): WireAttributes {
  const out: WireAttributes = {}
  for (const [name, type, value] of normalise(attrs ?? {})) {
    out[name] = { type, value: type === "i32" ? Number(value) : type === "bool" ? value === "true" : value }
  }
  return out
}

/** Rebuilds typed attribute inputs from the wire form. Throws on unknown types or bad values. */
export function fromWire(wire: WireAttributes): AttributeInputs {
  const out: Record<string, unknown> = {}
  for (const [name, { type, value }] of Object.entries(wire ?? {})) {
    const s = String(value)
    switch (type) {
      case "str": out[name] = str(s); break
      case "i32": out[name] = i32(Number(value)); break
      case "u64": out[name] = u64(BigInt(s)); break
      case "u256": out[name] = u256(BigInt(s)); break
      case "dec": out[name] = dec(s); break
      case "bool": out[name] = bool(value === true || s === "true"); break
      case "addr": out[name] = addr(s as `0x${string}`); break
      case "key": out[name] = key(s as `0x${string}`); break
      case "bytes32": out[name] = bytes32(s as `0x${string}`); break
      default: throw new Error(`unsupported attribute type ${type} on ${name}`)
    }
  }
  return out as AttributeInputs
}
