// Fingerprint guard (F1–F3): warns before writing anything too identifying.
import type { AttributeInputs } from "@arkiv-network/sdk"
import { toValue } from "@arkiv-network/sdk/attr"
import { EXPIRY_BUCKETS, PAD_BUCKETS } from "./constants.ts"
import { expirySeconds } from "./envelope.ts"

export type CheckWarning = {
  code:
    | "timestamp"
    | "precise-location"
    | "free-text"
    | "postal-code"
    | "expiry-rounded"
    | "expiry-too-long"
    | "payload-too-large"
    | "rare-combination"
  attribute?: string
  message: string
}

const TIME_NAME = /(^|[._-])(ts|time|timestamp|date|datetime|created|updated|at|when)$|(time|date|stamp)/i
const LOCATION_NAME = /(lat|lng|lon|latitude|longitude|geo|coord|location|gps)/i
const POSTAL_NAME = /(pin|pincode|zip|postal|postcode)/i
const COORD_PAIR = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/

/** Unix seconds 2001–2033 or unix milliseconds in the same range. */
function looksLikeTimestamp(n: number) {
  return (n >= 1e9 && n <= 2e9) || (n >= 1e12 && n <= 2e12)
}

function decimals(s: string) {
  const m = s.match(/\.(\d+)/)
  return m ? m[1].replace(/0+$/, "").length : 0
}

export function checkRecord(params: {
  attributes?: AttributeInputs
  expires?: { minLifetime: bigint } | number
  payload?: Uint8Array
}): CheckWarning[] {
  const out: CheckWarning[] = []
  for (const [name, input] of Object.entries(params.attributes ?? {})) {
    let type: string
    let raw: string
    try {
      const v = toValue(input as Parameters<typeof toValue>[0], name)
      type = v.type
      raw = String(v.value)
    } catch {
      continue
    }
    const numeric = ["i32", "u64", "u256", "dec"].includes(type)
    if (numeric && looksLikeTimestamp(Number(raw))) {
      out.push({ code: "timestamp", attribute: name, message: `${name} looks like an exact timestamp; store a coarse day or hour bucket instead` })
    } else if (TIME_NAME.test(name) && numeric && Number(raw) > 1e6) {
      out.push({ code: "timestamp", attribute: name, message: `${name} looks like a time value; prefer a coarse bucket` })
    }
    if ((LOCATION_NAME.test(name) && decimals(raw) > 4) || (type === "str" && COORD_PAIR.test(raw) && decimals(raw) > 4)) {
      out.push({ code: "precise-location", attribute: name, message: `${name} has more than 4 decimals of location (~11 m); round to 2–3 decimals` })
    }
    if (POSTAL_NAME.test(name)) {
      out.push({ code: "postal-code", attribute: name, message: `${name} is a postal code; in a small area it can identify a person, consider a district instead` })
    }
    if (type === "str" && raw.length > 32 && /\s/.test(raw)) {
      out.push({ code: "free-text", attribute: name, message: `${name} holds free text; put text in the payload (ideally encrypted), not in a queryable attribute` })
    }
  }
  if (params.expires !== undefined) {
    try {
      const secs = expirySeconds(params.expires)
      const bucket = EXPIRY_BUCKETS.find((b) => b >= secs)
      if (bucket === undefined) {
        out.push({ code: "expiry-too-long", message: `expiry of ${secs}s is past the 90-day maximum` })
      } else if (bucket !== secs) {
        out.push({ code: "expiry-rounded", message: `expiry of ${secs}s will be rounded up to ${bucket}s so it does not stand out` })
      }
    } catch (e) {
      out.push({ code: "expiry-too-long", message: (e as Error).message })
    }
  }
  if (params.payload && params.payload.length * 1.34 + 400 > PAD_BUCKETS.at(-1)!) {
    out.push({ code: "payload-too-large", message: `payload of ${params.payload.length} bytes will not fit the ${PAD_BUCKETS.at(-1)}-byte record limit` })
  }
  return out
}

/** Values that identify less, for attributes that must stay queryable (F3). */
export const coarse = {
  /** UTC day as YYYY-MM-DD. */
  day: (d: Date | number) => new Date(d).toISOString().slice(0, 10),
  /** UTC hour as YYYY-MM-DDTHH. */
  hour: (d: Date | number) => new Date(d).toISOString().slice(0, 13),
  /** A coordinate rounded to `decimals` places (2 ≈ 1 km), as a decimal string for `dec()`. */
  geo: (x: number, decimals = 2) => x.toFixed(decimals),
  /** A number rounded down to a multiple of `step` (ages, amounts). */
  bucket: (x: number, step: number) => Math.floor(x / step) * step,
}

/**
 * k-anonymity over attribute values: warns when fewer than `k` existing records of the app share
 * every attribute value this record would carry. A rare combination identifies its writer even
 * though the owner address is fresh.
 */
export function checkRarity(
  attributes: AttributeInputs | undefined,
  existing: readonly { attributes?: Record<string, { value: unknown } | undefined> }[],
  k: number,
): CheckWarning[] {
  const quasi = Object.entries(attributes ?? {})
    .filter(([name]) => name !== "project" && name !== "vtag")
    .map(([name, input]) => {
      try {
        return [name, String(toValue(input as Parameters<typeof toValue>[0], name).value)] as const
      } catch {
        return undefined
      }
    })
    .filter((x): x is readonly [string, string] => !!x)
  if (quasi.length === 0) return []
  const same = existing.filter((e) => quasi.every(([n, v]) => String(e.attributes?.[n]?.value) === v)).length
  if (same >= k) return []
  return [
    {
      code: "rare-combination",
      message: `only ${same} existing record(s) share these attribute values (${quasi.map(([n]) => n).join(", ")}); with fewer than ${k} the record stands out`,
    },
  ]
}
