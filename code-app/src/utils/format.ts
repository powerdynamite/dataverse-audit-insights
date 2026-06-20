/**
 * Converts a Dataverse logical field name to a human-readable label.
 * e.g. "hl_assetname" → "Asset Name", "createdon" → "Created On"
 */
export function formatFieldName(logicalName: string): string {
  // Strip common 2–4 char publisher prefix (e.g. "hl_", "cr7_", "new_")
  const stripped = logicalName.replace(/^[a-z]{2,4}_/, "");
  // Split on underscores, title-case each word
  return stripped
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Format an ISO date string for display */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
