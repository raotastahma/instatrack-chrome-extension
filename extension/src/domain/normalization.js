export function normalizeUsername(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
  return withoutAt.toLowerCase();
}

export function normalizeUsernames(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("Collected usernames must be an array.");
  }

  const unique = new Set();
  for (const value of values) {
    const username = normalizeUsername(value);
    if (username) {
      unique.add(username);
    }
  }

  return [...unique].sort();
}
