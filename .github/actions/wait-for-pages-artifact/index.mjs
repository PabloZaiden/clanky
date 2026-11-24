import { setTimeout as delay } from "node:timers/promises";
import { DefaultArtifactClient } from "@actions/artifact";

const name = process.env.PAGES_ARTIFACT_NAME;
const id = Number(process.env.PAGES_ARTIFACT_ID);
if (!name || !Number.isSafeInteger(id) || id <= 0) {
  throw new Error("The Pages upload did not provide an artifact name and ID.");
}

// deploy-pages looks up artifacts by name using this same runtime listing.
const artifact = new DefaultArtifactClient();
const waitMs = 30_000;
const deadline = performance.now() + waitMs;
let visible = false;
while (performance.now() < deadline) {
  const { artifacts } = await artifact.listArtifacts();
  const matches = artifacts.filter(candidate => candidate.name === name);
  if (matches.length > 0) {
    if (matches.length !== 1 || matches[0].id !== id) {
      throw new Error(`Listed artifact ${name} does not match the unique uploaded artifact ID ${id}.`);
    }
    visible = true;
    break;
  }
  await delay(Math.min(1_000, Math.max(0, deadline - performance.now())));
}

if (!visible) {
  throw new Error(`Uploaded Pages artifact ${name} (ID ${id}) did not appear in the Actions listing within ${waitMs / 1_000}s.`);
}
console.log(`Pages artifact ${name} (ID ${id}) is visible.`);
