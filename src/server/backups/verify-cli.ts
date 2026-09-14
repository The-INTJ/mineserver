import { verifyRestore } from "./restore.ts";
const [archive, world, destination] = process.argv.slice(2);
if (!archive || !world || !destination)
  throw new Error("Usage: npm run backup:verify -- <archive.zip> <world-name> <new-destination>");
console.warn(JSON.stringify(await verifyRestore(archive, world, destination), null, 2));
