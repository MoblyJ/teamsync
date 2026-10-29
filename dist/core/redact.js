// Defense-in-depth output scrubber. Even though we never print tokens on
// purpose, gh/git error text could embed credential material; every string
// we render or log passes through redact().
// GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghu_, ghs_, ghr_ + 36+ chars.
const GH_TOKEN_RE = /\bgh[posur]_[A-Za-z0-9]{16,}\b/g;
// Classic 40-hex tokens (legacy PATs) and generic long hex secrets next to
// "token"/"password" context.
const HEX_TOKEN_RE = /\b[a-f0-9]{40}\b/g;
const LABELED_SECRET_RE = /((?:token|password|passwd|secret|authorization|api[_-]?key)\s*[:=]\s*)(\S+)/gi;
export function redact(input) {
    let out = input;
    out = out.replace(GH_TOKEN_RE, "gh****REDACTED");
    out = out.replace(HEX_TOKEN_RE, "<40-hex redacted>");
    out = out.replace(LABELED_SECRET_RE, (_m, label) => `${label}****REDACTED`);
    return out;
}
/** Redact every string in an argv (for echoing commands safely). */
export function redactArgs(args) {
    return args.map((a) => redact(a));
}
