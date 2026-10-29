// CLI presentation layer. Deliberately thin: core modules produce data and
// events; this module renders them. Colors only on TTY and when NO_COLOR unset.
const isTTY = process.stdout.isTTY === true;
const useColor = isTTY && !process.env.NO_COLOR;
function c(code, s) {
    return useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
}
export const style = {
    bold: (s) => c("1", s),
    dim: (s) => c("2", s),
    green: (s) => c("32", s),
    yellow: (s) => c("33", s),
    red: (s) => c("31", s),
    cyan: (s) => c("36", s),
};
export function makeOutput(json) {
    return {
        say: (m) => (json ? undefined : console.log(m)),
        detail: (m) => (json ? undefined : console.log(`  ${style.dim(m)}`)),
        success: (m) => (json ? undefined : console.log(style.green(m))),
        warn: (m) => (json ? undefined : console.error(style.yellow(m))),
        error: (m) => (json ? undefined : console.error(style.red(m))),
        list: (items) => {
            if (json)
                return;
            for (const i of items)
                console.log(`  - ${i}`);
        },
        json: (value) => console.log(JSON.stringify(value, null, 2)),
    };
}
