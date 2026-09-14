const base = process.env.MINESERVER_URL ?? "http://127.0.0.1:3400";
const response = await fetch(`${base}/api/manager/shutdown`, { method: "POST" });
if (!response.ok) throw new Error(await response.text());
console.log("Graceful manager shutdown requested. Minecraft will save and stop first.");
