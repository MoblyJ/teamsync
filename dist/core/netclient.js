// Minimal JSON client for CLI→team-server calls. Node 20+ has global fetch.
import { networkError, TeamsyncError, isTeamsyncError } from "./errors.js";
export async function apiFetch(serverUrl, path, init = {}) {
    const url = new URL(path, serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`).toString();
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
    try {
        res = await fetch(url, {
            method: init.method ?? "GET",
            signal: controller.signal,
            headers: init.body !== undefined ? { "content-type": "application/json" } : {},
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
    }
    catch (err) {
        throw networkError(`Could not reach the TeamSync server at ${serverUrl} (${err.message}).`, [
            "Is `teamsync serve` running on the host machine?",
            "On another machine, pass its LAN address: --server http://192.168.x.x:4700",
            "Or find servers automatically: `teamsync team discover`",
        ]);
    }
    finally {
        clearTimeout(timer);
    }
    let body;
    try {
        body = await res.json();
    }
    catch {
        body = {};
    }
    if (!res.ok) {
        const errBody = body;
        throw new TeamsyncError({
            message: errBody.error?.message ?? `Server responded ${res.status}.`,
            code: errBody.error?.code ?? "server-error",
            exitCode: res.status === 403 ? 3 : res.status === 404 ? 6 : 1,
            hints: errBody.error?.hints ?? [],
        });
    }
    return { status: res.status, body: body };
}
export function isAuthFailure(err) {
    return isTeamsyncError(err) && err.code === "auth";
}
