/**
 * Ambient stub for `winax` (https://github.com/durs/winax) — a Windows-only native
 * COM/OLE Automation bridge. Declared here so `tsc` passes on non-Windows machines
 * where the optionalDependency is skipped by pnpm. At runtime the module is loaded
 * lazily (`await import("winax")`) ONLY inside Windows code paths; on Linux those
 * paths throw a "windows only" error before the import is reached.
 *
 * winax exposes a single `Object` constructor that instantiates a COM ProgID (e.g.
 * `new winax.Object("Redemption.RDOSession")`) and returns a dynamically-dispatched
 * proxy. We type that proxy loosely as `any` because the member surface is the
 * Redemption RDO object model, not a statically-knowable TypeScript shape — the
 * precise members we call are documented at the call sites in src/platform/redemption.ts.
 */
declare module "winax" {
  /** A late-bound COM automation object. Members resolve via IDispatch at runtime. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ComObject = any;

  /**
   * Instantiate a COM object by ProgID or CLSID. Callable with `new` (the common form,
   * `new winax.Object("Redemption.RDOSession")`) or as a plain call. Optional `options`
   * mirror winax's activation flags; we pass none in this collector.
   */
  interface ComObjectConstructor {
    new (progId: string, options?: Record<string, unknown>): ComObject;
    (progId: string, options?: Record<string, unknown>): ComObject;
  }
  export const Object: ComObjectConstructor;

  /** Release a COM object's underlying IDispatch reference deterministically. */
  export function release(obj: ComObject): void;

  const _default: {
    Object: ComObjectConstructor;
    release: typeof release;
  };
  export default _default;
}
