// CLI presentation layer. Deliberately thin: core modules produce data and
// events; this module renders them. Colors only on TTY and when NO_COLOR unset.

const isTTY = process.stdout.isTTY === true;
const useColor = isTTY && !process.env.NO_COLOR;

function c(code: string, s: string): string {
  return useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export const style = {
  bold: (s: string) => c("1", s),
  dim: (s: string) => c("2", s),
  green: (s: string) => c("32", s),
  yellow: (s: string) => c("33", s),
  red: (s: string) => c("31", s),
  cyan: (s: string) => c("36", s),
};

export interface Output {
  say(message: string): void;
  detail(message: string): void; // dim, indented
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  list(items: readonly string[]): void;
  /** JSON mode output — call instead of human rendering. */
  json(value: unknown): void;
}

export function makeOutput(json: boolean): Output {
  return {
    say: (m) => (json ? undefined : console.log(m)),
    detail: (m) => (json ? undefined : console.log(`  ${style.dim(m)}`)),
    success: (m) => (json ? undefined : console.log(style.green(m))),
    warn: (m) => (json ? undefined : console.error(style.yellow(m))),
    error: (m) => (json ? undefined : console.error(style.red(m))),
    list: (items) => {
      if (json) return;
      for (const i of items) console.log(`  - ${i}`);
    },
    json: (value) => console.log(JSON.stringify(value, null, 2)),
  };
}
