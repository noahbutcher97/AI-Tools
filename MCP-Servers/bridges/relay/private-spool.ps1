# Prepare a private local file. The message never enters this process.
$ErrorActionPreference = 'Stop'
try {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $Path = [Console]::In.ReadToEnd()
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $trusted = @($owner.Value, 'S-1-5-18', 'S-1-5-32-544',
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') # TrustedInstaller

    function Assert-Access($acl, [bool]$private) {
        $sd = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
        if ($sd.Owner.Value -notin $trusted -or $null -eq $sd.DiscretionaryAcl) { throw 'access' }
        # Reject effective rights that could replace or redirect a checked component.
        $unsafe = [int][Security.AccessControl.FileSystemRights]'WriteData,WriteAttributes,WriteExtendedAttributes,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
        $unsafe = $unsafe -bor 0x50000000 # GENERIC_WRITE and GENERIC_ALL
        if ($private) { $unsafe = $unsafe -bor 7 -bor [int]::MinValue } # read, write, append, GENERIC_READ
        foreach ($ace in $sd.DiscretionaryAcl) {
            if ($ace.AceType -notin @('AccessAllowed','AccessDenied')) { throw 'access' }
            if ($ace.AceType -eq 'AccessDenied' -or $ace.SecurityIdentifier.Value -in $trusted -or
                (([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0)) { continue }
            if ($ace.AccessMask -band $unsafe) { throw 'access' }
        }
    }

    # Accept only ordinary absolute paths on local fixed drives.
    if ($Path -notmatch '^[a-z]:\\' -or $Path -ne [IO.Path]::GetFullPath($Path) -or
        [IO.DriveInfo]::new($Path.Substring(0,3)).DriveType -ne 'Fixed' -or
        [IO.DriveInfo]::new($Path.Substring(0,3)).DriveFormat -notin @('NTFS','ReFS')) { throw 'path' }
    foreach ($part in $Path.Substring(3).Split('\')) {
        if (!$part -or $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
            $part -match '[. ]$|^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)') { throw 'path' }
    }
    $parent = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($Path))
    $chain = [Collections.Stack]::new()
    for ($dir = $parent; $null -ne $dir; $dir = $dir.Parent) { $chain.Push($dir) }
    while ($chain.Count) {
        $dir = $chain.Pop()
        if (!$dir.Exists) {
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetOwner($owner)
            $acl.SetAccessRuleProtection($true, $false)
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
            $dir.Create($acl)
        }
        $dir.Refresh()
        if (!$dir.Exists -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'directory' }
        Assert-Access $dir.GetAccessControl() ($chain.Count -eq 0)
    }

    if (![IO.File]::Exists($Path)) {
        $acl = [Security.AccessControl.FileSecurity]::new()
        $acl.SetOwner($owner)
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner,'FullControl','Allow'))
        try {
            $stream = [IO.FileStream]::new($Path,'CreateNew',[Security.AccessControl.FileSystemRights]::Write,'ReadWrite',4096,'None',$acl)
            $stream.Dispose()
        } catch [IO.IOException] {
            if (![IO.File]::Exists($Path)) { throw }
        }
    }
    $file = [IO.FileInfo]::new($Path)
    if (!$file.Exists -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'file' }
    Assert-Access $file.GetAccessControl() $true
    exit 0
} catch {
    exit 1
}
