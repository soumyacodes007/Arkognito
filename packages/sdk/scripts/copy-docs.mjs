// Include the canonical integration guide in the published package.
import { copyFileSync } from "node:fs"
copyFileSync(new URL("../../../docs/semaphore.md", import.meta.url), new URL("../SEMAPHORE.md", import.meta.url))
