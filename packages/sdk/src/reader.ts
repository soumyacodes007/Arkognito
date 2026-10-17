// Reading Arkognito records: verification (R1, R2) and the download-and-filter listing (D1).
import type { Entity, PublicArkivClient } from "@arkiv-network/sdk"
import { eq } from "@arkiv-network/sdk/query"
import type { Address, Hex } from "viem"
import { BLOCK_TIME_SECONDS } from "./constants.ts"
import { type Envelope, envelopeSigner, fromBase64, parseEnvelope } from "./envelope.ts"

export type ArkivReader = Pick<PublicArkivClient, "select" | "getEntity" | "getBlockNumber" | "query">

export type VerifiedRecord = {
  entityKey: Hex
  owner: Address
  creator: Address
  app: string
  contentType: string
  data: Uint8Array
  expSeconds: number
  createdAt?: bigint
  expiresAt?: bigint
  attributes: Entity["attributes"]
  envelope: Envelope
}

export type VerifyResult = { ok: true; record: VerifiedRecord } | { ok: false; reason: string }

/** The fields verification reads: a full `getEntity` result, or a query selecting at least these. */
export type RecordEntity = Pick<Entity, "key" | "owner" | "creator" | "payload" | "attributes"> &
  Partial<Pick<Entity, "createdAt" | "expiresAt">>

/** Allowed gap, in blocks, between the signed expiry bucket and the expiry the chain recorded. */
const EXPIRY_TOLERANCE_BLOCKS = 30n

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/**
 * Checks one entity is an honest Arkognito record: the envelope signature recovers to $owner over the
 * on-chain attributes, the expiry matches the signed bucket, and (optionally) the app and creator match.
 * Needs an entity fetched with key, owner, creator, payload, attributes, createdAt and expiresAt.
 *
 * An inbox record (inbox.ts) is signed by a key derived for its recipient, not by its owner: its
 * recipient passes that address as `signer`.
 */
export async function verifyRecord(
  entity: RecordEntity,
  expect: { app?: string; relayers?: readonly Address[]; owner?: Address; signer?: Address } = {},
): Promise<VerifyResult> {
  if (!entity.key || !entity.owner || !entity.creator || !entity.payload) {
    return { ok: false, reason: "entity is missing key, owner, creator or payload" }
  }
  let envelope: Envelope
  try {
    envelope = parseEnvelope(entity.payload)
  } catch (e) {
    return { ok: false, reason: `bad envelope: ${(e as Error).message}` }
  }
  if (expect.app && envelope.app !== expect.app) return { ok: false, reason: `app is ${envelope.app}, expected ${expect.app}` }
  if (expect.owner && !same(entity.owner, expect.owner)) {
    return { ok: false, reason: `owner is ${entity.owner}, expected ${expect.owner}` }
  }
  if (expect.relayers && !expect.relayers.some((r) => same(r, entity.creator))) {
    return { ok: false, reason: `creator ${entity.creator} is not a known relayer` }
  }
  let signer: Address
  try {
    signer = await envelopeSigner(envelope, entity.attributes)
  } catch {
    return { ok: false, reason: "envelope signature is malformed" }
  }
  if (!same(signer, expect.signer ?? entity.owner)) {
    return {
      ok: false,
      reason: expect.signer
        ? "envelope signature does not match the inbox sender key (content, attributes or expiry were changed)"
        : "envelope signature does not match $owner (content, attributes or expiry were changed)",
    }
  }
  if (entity.createdAt !== undefined && entity.expiresAt !== undefined) {
    const lifetime = entity.expiresAt - entity.createdAt
    const signed = BigInt(Math.round(envelope.exp / BLOCK_TIME_SECONDS))
    const diff = lifetime > signed ? lifetime - signed : signed - lifetime
    if (diff > EXPIRY_TOLERANCE_BLOCKS) {
      return { ok: false, reason: `expiry is ${lifetime} blocks, envelope signed ${signed}` }
    }
  }
  return {
    ok: true,
    record: {
      entityKey: entity.key,
      owner: entity.owner,
      creator: entity.creator,
      app: envelope.app,
      contentType: envelope.ct,
      data: fromBase64(envelope.data),
      expSeconds: envelope.exp,
      createdAt: entity.createdAt,
      expiresAt: entity.expiresAt,
      attributes: entity.attributes,
      envelope,
    },
  }
}

/** Fetches one entity with every field verification needs. */
export async function fetchFull(client: ArkivReader, entityKey: Hex): Promise<Entity> {
  return client.getEntity(entityKey)
}

/**
 * Every record of one app project, as of one block: key, owner, creator, creation block and
 * attributes (which carry each record's encrypted `vtag`), but no payloads. The query names no user
 * address, so the RPC provider learns nothing about which records are ours (D1).
 *
 * The page-through is pinned to one block: Arkiv cursors are tied to the block they were read at,
 * and the SDK's own iterator fails if a block lands between pages (see arkiv/friction.md).
 */
export async function listApp(client: ArkivReader, project: string, relayers: readonly Address[] = []): Promise<AppEntry[]> {
  const head = await client.getBlockNumber()
  const out: AppEntry[] = []
  // No relayers given: every record of the project, whoever created it. Each one is verified later anyway.
  for (const relayer of relayers.length ? relayers : [undefined]) {
    let query = client
      .select({ key: true, owner: true, creator: true, createdAt: true, attributes: true })
      .where(eq("project", project))
      .limit(200)
      .atBlock(head)
    if (relayer) query = query.createdBy(relayer)
    for await (const e of query) {
      const tag = e.attributes.vtag?.value
      out.push({ key: e.key, owner: e.owner, creator: e.creator, createdAt: e.createdAt, attributes: e.attributes, tag: typeof tag === "string" ? tag : undefined })
    }
  }
  return out
}

/** A record fetched with every field verification needs. */
export type FullRecord = {
  creationFlags?: Entity["creationFlags"]
  key: Hex
  owner: Address
  creator: Address
  payload: Uint8Array
  attributes: Entity["attributes"]
  createdAt: bigint
  expiresAt: bigint
}

export type AppEntry = { key: Hex; owner: Address; creator: Address; createdAt: bigint; attributes: Entity["attributes"]; tag?: string }

/**
 * Full records of whole batches, each named by its creation block and creator. Fetching a batch
 * tells the RPC provider "this client cares about one of these records", never which one. The SDK's
 * query builder refuses `$createdAt` filters, but the node supports them, so this uses a raw query.
 */
export async function fetchBatches(
  client: ArkivReader,
  project: string,
  batches: readonly { block: bigint; creator: Address }[],
): Promise<FullRecord[]> {
  const out: FullRecord[] = []
  for (const b of batches) {
    const q = `${eq("project", project).toString()} AND $createdAt = u64(${b.block}) AND $creator = addr(${b.creator})`
    let cursor: string | undefined
    let atBlock: bigint | undefined
    do {
      const page = await client.query(q, {
        select: { key: true, owner: true, creator: true, payload: true, attributes: true, createdAt: true, expiresAt: true, creationFlags: true },
        limit: 200,
        cursor,
        atBlock,
      })
      atBlock = page.blockNumber
      out.push(...(page.entities as unknown as FullRecord[]))
      cursor = page.cursor
    } while (cursor)
  }
  return out
}

/**
 * Every record of one app project, payloads included, as of one block. For small apps this is the
 * private way to read: the RPC provider sees the whole app downloaded, so it learns nothing about
 * which records are yours (better than fetching your batches plus cover batches).
 */
export async function fetchProject(client: ArkivReader, project: string, atBlock?: bigint): Promise<FullRecord[]> {
  const q = eq("project", project).toString()
  const out: FullRecord[] = []
  let cursor: string | undefined
  let block = atBlock
  do {
    const page = await client.query(q, {
      select: { key: true, owner: true, creator: true, payload: true, attributes: true, createdAt: true, expiresAt: true, creationFlags: true },
      limit: 200,
      cursor,
      atBlock: block,
    })
    block = page.blockNumber
    out.push(...(page.entities as unknown as FullRecord[]))
    cursor = page.cursor
  } while (cursor)
  return out
}
