/**
 * Ambient stub for `win-dpapi` — a Windows-only native binding around the Win32
 * Data Protection API (CryptProtectData / CryptUnprotectData). Declared here so
 * `tsc` passes where the optionalDependency is skipped (non-Windows). Loaded lazily
 * (`await import("win-dpapi")`) only inside the Windows DPAPI code path
 * (src/platform/dpapi.ts); on other platforms we fall back to a PowerShell shim, or
 * throw "windows only".
 *
 * Scope "CurrentUser" ties the sealed blob to the logged-on user's security context
 * (docs/15 §8.1) — a copied blob cannot be unsealed as another user.
 */
declare module "win-dpapi" {
  export type DpapiScope = "CurrentUser" | "LocalMachine";

  /** Seal `data` with the given scope; optional entropy strengthens the key. */
  export function protectData(
    data: Buffer,
    optionalEntropy: Buffer | null,
    scope: DpapiScope,
  ): Buffer;

  /** Unseal a blob previously produced by `protectData` with the same entropy/scope. */
  export function unprotectData(
    data: Buffer,
    optionalEntropy: Buffer | null,
    scope: DpapiScope,
  ): Buffer;

  const _default: {
    protectData: typeof protectData;
    unprotectData: typeof unprotectData;
  };
  export default _default;
}
