export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export function EnvBadge({ env }: { env: "client" | "server" | "*" }) {
  const label = env === "*" ? "both" : env;
  return <span className={`badge env-${env === "*" ? "both" : env}`}>{label}</span>;
}
