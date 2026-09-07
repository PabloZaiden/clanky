import { ensureMacOSSigningCertificate } from "./macos-signing";

const files = await ensureMacOSSigningCertificate();
console.log(`macOS signing certificate ready at ${files.certificatePath}`);
console.log(`macOS signing password stored at ${files.passwordPath}`);
