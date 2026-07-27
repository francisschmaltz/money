import { createHash } from "node:crypto";

export function stableId(kind, value) {
  if (!kind || value == null) throw new TypeError("kind and value are required");
  return `${kind}_${createHash("sha256")
    .update(`${kind}\0${String(value)}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function stableFindingId(family, rule, identity, periodEnd = "") {
  return stableId("finding", `${family}:${rule}:${identity}:${periodEnd}`);
}

export function stableFindingKey(family, rule, identity) {
  return stableId("finding-key", `${family}:${rule}:${identity}`);
}
