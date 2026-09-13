import os from "node:os";

/** Best-guess LAN IPv4 for the "tell Adaline to connect here" hint. */
export function lanIp(): string | null {
  const all = Object.values(os.networkInterfaces()).flat();
  const v4 = all.filter(
    (n): n is os.NetworkInterfaceInfoIPv4 => !!n && n.family === "IPv4" && !n.internal,
  );
  const score = (ip: string) =>
    ip.startsWith("192.168.")
      ? 3
      : ip.startsWith("10.")
        ? 2
        : /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
          ? 1
          : 0;
  v4.sort((a, b) => score(b.address) - score(a.address));
  return v4[0]?.address ?? null;
}
