import { resolveRepoRoot } from "./surreal.js";

export type CliArgs = Record<string, string>;

/** Minimal argv parser shared by dfc scripts. Supports --flag, --key value, and --key=value. */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Resolve the target repo root for scripts that run from the plugin package. */
export function repoRootFromArgs(args: CliArgs): string {
  return resolveRepoRoot(args["repo-root"]);
}

export function positiveIntArg(args: CliArgs, key: string): number | undefined {
  const raw = args[key];
  if (!raw || raw === "true") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return parsed;
}
