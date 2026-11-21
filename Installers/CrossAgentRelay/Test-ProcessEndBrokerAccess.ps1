# Read-only DACL check for this disposable Windows PowerShell process.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run in a fresh, ordinary desktop PowerShell process.'
}
$file = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'CrossAgentRelay/watcher-install.json'
$record = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
if ($record.status -cne 'installed' -or $record.sessionSid -cne $identity.User.Value -or
    $record.brokerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$' -or $record.brokerSid -eq $record.sessionSid) {
    throw 'Expected an enrolled desktop with a separate broker identity.'
}
# GetEffectiveRightsFromAcl evaluates the named trustee and groups. It does not
# run under the broker logon token or exercise OpenProcess from the broker.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class RelayProcessAclTrial {
    [StructLayout(LayoutKind.Sequential)]
    private struct Trustee {
        public IntPtr MultipleTrustee;
        public int MultipleOperation, Form, Type;
        public IntPtr Name;
    }
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(IntPtr handle, int type, uint information,
        IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", ExactSpelling=true)]
    private static extern uint GetEffectiveRightsFromAclW(IntPtr acl, ref Trustee trustee, out uint rights);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr address);

    public static bool AllowsObservation(SecurityIdentifier identity) {
        IntPtr acl, descriptor;
        uint error = GetSecurityInfo(GetCurrentProcess(), 6 /* SE_KERNEL_OBJECT */, 4 /* DACL */,
            IntPtr.Zero, IntPtr.Zero, out acl, IntPtr.Zero, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            if (acl == IntPtr.Zero) throw new InvalidOperationException("Expected a process DACL.");
            byte[] sid = new byte[identity.BinaryLength];
            identity.GetBinaryForm(sid, 0);
            GCHandle pinned = GCHandle.Alloc(sid, GCHandleType.Pinned);
            try {
                Trustee user = new Trustee { Form = 0 /* TRUSTEE_IS_SID */, Type = 1 /* TRUSTEE_IS_USER */,
                    Name = pinned.AddrOfPinnedObject() };
                uint granted;
                error = GetEffectiveRightsFromAclW(acl, ref user, out granted);
                if (error != 0) throw new Win32Exception((int)error);
                const uint required = 0x00100000 | 0x1000; // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
                return (granted & required) == required;
            } finally { pinned.Free(); }
        } finally { LocalFree(descriptor); }
    }
}
'@
$broker = [Security.Principal.SecurityIdentifier]::new($record.brokerSid)
$desktopAllowed = [RelayProcessAclTrial]::AllowsObservation($identity.User)
if (!$desktopAllowed) { throw 'Desktop DACL control did not have query and synchronization rights.' }
[pscustomobject]@{
    desktopDaclAllowsObservation = $desktopAllowed
    brokerDaclAllowsObservation = [RelayProcessAclTrial]::AllowsObservation($broker)
    brokerLogonExercised = $false
} | ConvertTo-Json -Compress
