// One entry point for every Arkognito service, chosen by ROLE:
//   ROLE=relayer      (default) a relayer; add ISSUER=on to also run the token issuer
//   ROLE=ohttp-relay  an Oblivious HTTP relay (run it under a different operator than the relayers)
// The Docker image runs this file, so one image serves every role.
// The role can also be the first argument: tsx start.ts ohttp-relay
const role = process.argv[2] ?? process.env.ROLE ?? "relayer"

if (role === "relayer") {
  await import("./main")
} else if (role === "ohttp-relay") {
  const { startOhttpRelay } = await import("./ohttp-relay")
  const relay = startOhttpRelay({
    port: Number(process.env.OHTTP_RELAY_PORT ?? process.env.PORT ?? 8790),
    rpcUrl: process.env.ARKIV_RPC_URL,
    accessKey: process.env.ARKIV_ACCESS_KEY,
    targets: process.env.OHTTP_TARGETS?.split(",").filter(Boolean),
    allowLocal: process.env.OHTTP_ALLOW_LOCAL === "on",
  })
  await relay.listen()
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void relay.close().then(() => process.exit(0)))
} else {
  console.error(`unknown ROLE "${role}" (use relayer or ohttp-relay)`)
  process.exit(1)
}

export {}
