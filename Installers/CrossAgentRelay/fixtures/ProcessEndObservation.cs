using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ProcessEndObservationFixture
{
    private const uint Synchronize = 0x00100000;
    private const uint QueryLimitedInformation = 0x1000;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int id);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeProcessHandle handle, out long creation,
        out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(SafeProcessHandle handle, out uint code);

    public static SafeProcessHandle Open(Process ownedChild)
    {
        var handle = OpenProcess(Synchronize | QueryLimitedInformation, false, ownedChild.Id);
        if (handle.IsInvalid)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }

    public static long CreationFileTime(SafeProcessHandle handle)
    {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return creation;
    }

    public static string Observe(SafeProcessHandle handle, long expectedCreation, uint waitMs)
    {
        if (handle == null || handle.IsClosed || handle.IsInvalid)
            return "unknown";
        if (CreationFileTime(handle) != expectedCreation)
            return "unknown";
        switch (WaitForSingleObject(handle, waitMs))
        {
            case 258: // WAIT_TIMEOUT
                return "running";
            case 0: // WAIT_OBJECT_0
                uint code;
                if (!GetExitCodeProcess(handle, out code))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return "exit " + code;
            default:
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
