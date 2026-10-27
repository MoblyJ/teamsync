// Default exclusion of likely secret/credential files from `teamsync submit`.
// Excluded files are never staged; the user is told exactly what was skipped
// and how to commit those deliberately with plain git if appropriate.

export interface SecretMatch {
  path: string; // repo-relative
  reason: string;
}

const BASENAME_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /^\.env($|\.)/i, reason: "dotenv-style environment file" },
  { re: /^credentials(\.json)?$/i, reason: "credentials file" },
  { re: /^secret(s)?(\.|$)/i, reason: "secret-named file" },
  { re: /\.pem$/i, reason: "PEM key material" },
  { re: /\.key$/i, reason: "private key file" },
  { re: /\.pfx$|\.p12$/i, reason: "PKCS#12 keystore" },
  { re: /^id_rsa($|\.)|^id_ed25519($|\.)|^id_ecdsa($|\.)|^id_dsa($|\.)/, reason: "SSH private key" },
  { re: /^\.npmrc$|^\.pypirc$|^\.netrc$/, reason: "registry credentials file" },
  { re: /^secrets?\.(ya?ml|json|toml|ini)$/i, reason: "secrets config" },
  { re: /^\.git-credentials$/, reason: "git credential store" },
  { re: /^\.gh$/i, reason: "gh config/hosts file" },
  { re: /(^|\/)\.?service-account.*\.json$/i, reason: "service account key" },
  { re: /^keystore\.jks$|\.jks$/i, reason: "Java keystore" },
];

const CONTAINS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)\.env\./i, reason: "dotenv-style environment file" },
  { re: /(^|\/)(secret|credential|private[_-]?key|token)/i, reason: "secret-named path segment" },
  { re: /\.pem$|\.key$|\.pfx$|\.p12$|\.jks$|\.keystore$/i, reason: "key material extension" },
];

/**
 * Return the subset of candidate paths that look like credential material.
 * Only names/shapes are inspected — file contents are never read.
 */
export function findLikelySecretFiles(paths: readonly string[]): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const p of paths) {
    const posix = p.replace(/\\/g, "/");
    const base = posix.split("/").pop() ?? posix;
    for (const { re, reason } of BASENAME_PATTERNS) {
      if (re.test(base) || CONTAINS_PATTERNS.some((c) => c.re.test(posix) && c.reason === reason)) {
        out.push({ path: posix, reason });
        break;
      }
    }
  }
  return out;
}

export function splitExcluded<T extends { path: string }>(
  files: readonly T[],
  excluded: readonly SecretMatch[],
): { kept: T[]; excludedFiles: T[] } {
  const set = new Set(excluded.map((e) => e.path));
  const kept: T[] = [];
  const excludedFiles: T[] = [];
  for (const f of files) (set.has(f.path.replace(/\\/g, "/")) ? excludedFiles : kept).push(f);
  return { kept, excludedFiles };
}
