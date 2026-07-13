/**
 * Windows Account Manager (WAM) cached-account enumeration (docs/15 §3.2).
 *
 * New Outlook exposes no enumeration API; its Microsoft-identity accounts are only
 * discoverable via the OS-level WAM broker cache, which BOTH Outlook flavors register
 * into. There is no first-class Node binding for the WebAccountManager WinRT API, so
 * this queries the broker through a PowerShell bridge over the WinRT projection
 * (`Windows.Security.Authentication.Web.Core.WebAuthenticationCoreManager` /
 * `Windows.Security.Credentials.WebAccount`).
 *
 * NOTE (Windows-validated by the user): the exact WinRT call to enumerate *cached*
 * accounts for the Mail scope is `FindAllAccountsAsync(provider)` against the MSA/AAD
 * provider; the projection surface differs slightly across Windows builds. We code
 * against the documented member names and shape the output into `WamAccount`; if a
 * build lacks the projection, the probe returns [] and the collector simply relies on
 * MAPI + user-configured discovery instead (never a hard failure — docs/15 §3.2).
 */

import { assertWindows, powershell } from "./native.js";
import { log } from "../log.js";

export interface WamAccount {
  upn: string;
  tenantId?: string;
}

/** WinRT bridge script: returns JSON lines of { upn, tenantId } for cached Mail accounts. */
const WAM_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Windows.Security.Authentication.Web.Core.WebAuthenticationCoreManager,Windows.Security.Authentication.Web.Core,ContentType=WindowsRuntime] | Out-Null
[Windows.Security.Credentials.WebAccount,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
function Await($op, $t) {
  $task = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethodDefinition } |
    Select-Object -First 1
  $g = $task.MakeGenericMethod($t)
  $res = $g.Invoke($null, @($op)); $res.Wait(); return $res.Result
}
$results = @()
foreach ($authority in @('https://login.microsoft.com','consumers','organizations')) {
  $provOp = [Windows.Security.Authentication.Web.Core.WebAuthenticationCoreManager]::FindAccountProviderAsync('https://login.microsoft.com', $authority)
  $provider = Await $provOp ([Windows.Security.Credentials.WebAccountProvider])
  if ($provider -ne $null) {
    $accOp = [Windows.Security.Authentication.Web.Core.WebAuthenticationCoreManager]::FindAllAccountsAsync($provider)
    $accRes = Await $accOp ([Windows.Security.Authentication.Web.Core.FindAllAccountsResult])
    if ($accRes -ne $null -and $accRes.Accounts -ne $null) {
      foreach ($a in $accRes.Accounts) {
        $results += [pscustomobject]@{ upn = $a.UserName; tenantId = $a.Properties['TenantId'] }
      }
    }
  }
}
$results | Sort-Object upn -Unique | ForEach-Object { $_ | ConvertTo-Json -Compress }
`;

/** Enumerate WAM-cached Microsoft-identity accounts scoped to Mail (docs/15 §3.2). */
export async function cachedAccounts(): Promise<WamAccount[]> {
  assertWindows("WindowsAccountManager");
  try {
    const out = await powershell(WAM_SCRIPT, 30_000);
    const accounts: WamAccount[] = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed) as { upn?: string; tenantId?: string };
        if (parsed.upn) accounts.push({ upn: parsed.upn, tenantId: parsed.tenantId || undefined });
      } catch {
        /* skip malformed line */
      }
    }
    return accounts;
  } catch (err) {
    log.warn("WAM enumeration unavailable; relying on MAPI + user-configured accounts", {
      err: String(err),
    });
    return [];
  }
}
