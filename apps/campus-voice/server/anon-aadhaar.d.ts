// The parts of @anon-aadhaar/core 2.4.3 the Campus Voice server uses. The package ships its TypeScript
// sources, which do not pass this repo's strict typecheck, so the root tsconfig maps the module here.
declare module "@anon-aadhaar/core" {
  export enum ArtifactsOrigin {
    server = 0,
    local = 1,
    chunked = 2,
  }
  export const artifactUrls: { v2: { wasm: string; zkey: string; vk: string; chunked: string } }
  export const testPublicKeyHash: string
  export type AnonAadhaarProof = {
    groth16Proof: unknown
    pubkeyHash: string
    timestamp: string
    nullifierSeed: string
    nullifier: string
    signalHash: string
    ageAbove18: string
    gender: string
    pincode: string
    state: string
  }
  export type AnonAadhaarClaim = { pubKey: string; signalHash: string; ageAbove18: boolean | null; gender: string | null; pincode: string | null; state: string | null }
  export class AnonAadhaarCore {
    type: string
    id: string
    claim: AnonAadhaarClaim
    proof: AnonAadhaarProof
  }
  export type AnonAadhaarArgs = Record<string, unknown>
  export function init(args: { wasmURL: string; zkeyURL: string; vkeyURL: string; artifactsOrigin: ArtifactsOrigin }): Promise<void>
  export function generateArgs(options: { qrData: string; certificateFile: string; nullifierSeed: number | bigint | string; fieldsToRevealArray?: string[]; signal?: string }): Promise<AnonAadhaarArgs>
  export function prove(args: AnonAadhaarArgs, updateState?: (state: string) => void): Promise<AnonAadhaarCore>
  export function verify(pcd: AnonAadhaarCore, useTestAadhaar?: boolean): Promise<boolean>
  export function hash(message: string | number | bigint): string
  export function convertBigIntToByteArray(bigInt: bigint): Uint8Array
  export function decompressByteArray(byteArray: Uint8Array): Uint8Array
  export function compressByteArray(byteArray: Uint8Array): Uint8Array
  export function extractPhoto(qrDataPadded: number[], dataLength: number): { begin: number; dataLength: number; bytes: number[] }
  export function getRandomBytes(length: number): Uint8Array
  export function replaceBytesBetween(arr: Uint8Array, replaceWith: Uint8Array, start: number, end: number): Uint8Array
  export function returnNewDateString(): string
}
