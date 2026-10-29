// Actionable error types with stable exit codes.
// Every error surfaced to a user should carry hints that tell them what to do
// next, not just what went wrong.
export const ExitCode = {
    OK: 0,
    GENERAL: 1,
    USAGE: 2,
    BLOCKED: 3, // dirty worktree, conflict, unsafe operation refused
    AUTH: 4, // expired/missing authentication or insufficient permission
    NETWORK: 5, // network failure or rate limit
    NOT_FOUND: 6, // repo, branch, config file, etc.
    CONFIG: 7, // invalid or unsupported .teamsync/config.json
    UNSUPPORTED: 8, // capability missing on the server/plan side
};
export class TeamsyncError extends Error {
    code;
    exitCode;
    hints;
    constructor(opts) {
        super(opts.message);
        this.name = "TeamsyncError";
        this.code = opts.code;
        this.exitCode = opts.exitCode ?? ExitCode.GENERAL;
        this.hints = opts.hints ?? [];
    }
    toJSON() {
        return {
            error: {
                code: this.code,
                message: this.message,
                hints: this.hints,
            },
        };
    }
}
export function usageError(message, hints = []) {
    return new TeamsyncError({ message, code: "usage", exitCode: ExitCode.USAGE, hints });
}
export function blockedError(message, hints = []) {
    return new TeamsyncError({ message, code: "blocked", exitCode: ExitCode.BLOCKED, hints });
}
export function authError(message, hints = []) {
    return new TeamsyncError({
        message,
        code: "auth",
        exitCode: ExitCode.AUTH,
        hints: hints.length > 0 ? hints : ["Run `teamsync login` to refresh GitHub authentication."],
    });
}
export function networkError(message, hints = []) {
    return new TeamsyncError({
        message,
        code: "network",
        exitCode: ExitCode.NETWORK,
        hints,
    });
}
export function notFoundError(message, hints = []) {
    return new TeamsyncError({ message, code: "not-found", exitCode: ExitCode.NOT_FOUND, hints });
}
export function configError(message, hints = []) {
    return new TeamsyncError({ message, code: "config", exitCode: ExitCode.CONFIG, hints });
}
export function unsupportedError(message, hints = []) {
    return new TeamsyncError({
        message,
        code: "unsupported",
        exitCode: ExitCode.UNSUPPORTED,
        hints,
    });
}
export function isTeamsyncError(e) {
    return e instanceof TeamsyncError;
}
