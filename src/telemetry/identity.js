import { createHash, createHmac } from "node:crypto";

export function projectedGuidanceProvenance(policyText) {
  if (typeof policyText !== "string" || !policyText.endsWith("\n")) {
    throw new TypeError("INVALID_POLICY_PROJECTION");
  }
  return Object.freeze({
    policy_projection_sha256: createHash("sha256").update(policyText, "utf8").digest("hex"),
    projected_guidance_bytes: Buffer.byteLength(policyText, "utf8"),
  });
}

export function hmacRef(key, raw) {
  if ((typeof key !== "string" && !Buffer.isBuffer(key)) || typeof raw !== "string") {
    throw new TypeError("INVALID_HMAC_REFERENCE");
  }
  return createHmac("sha256", key).update(raw, "utf8").digest("hex");
}
