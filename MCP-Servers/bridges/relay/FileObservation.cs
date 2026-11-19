using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// The caller supplies a volume GUID and paths from protected policy. Open the
// approved directory relative to the volume, then the file relative to that
// directory handle. Neither open may follow a filesystem reparse point.
public static class FileObservation {
    private const uint Attributes = 0x80, Traverse = 0x20, ShareAll = 7;
    private const uint DirectoryFile = 1, NonDirectoryFile = 0x40;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes {
        public int Length;
        public IntPtr Root, Name;
        public uint Flags;
        public IntPtr Descriptor, Quality;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatus { public IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileId { public ulong Volume, Low, High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Information {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("ntdll.dll")]
    private static extern int NtOpenFile(out SafeFileHandle file, uint access, ref ObjectAttributes attributes,
        out IoStatus result, uint share, uint options);
    [DllImport("kernel32.dll")]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information info);
    [DllImport("kernel32.dll")]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out FileId id, int size);

    private static string RelativeName(string name) {
        if (String.IsNullOrEmpty(name) || name.Length > 1024) throw new InvalidDataException();
        string[] parts = name.Split('/');
        if (parts.Length > 32) throw new InvalidDataException();
        foreach (string part in parts) {
            if (part.Length == 0 || part.Length > 255 || part.EndsWith(".", StringComparison.Ordinal) ||
                    part.EndsWith(" ", StringComparison.Ordinal) || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new InvalidDataException();
        }
        return String.Join(@"\", parts);
    }

    private static SafeFileHandle OpenVolume(string volume) {
        Guid id;
        if (!Guid.TryParseExact(volume, "D", out id)) throw new InvalidDataException();
        string name = @"\\?\Volume{" + id.ToString("D") + @"}\";
        if (GetDriveTypeW(name) != 3) throw new IOException();
        var handle = CreateFileW(name, Attributes | Traverse, ShareAll, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();
        throw new IOException();
    }

    private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, bool directory) {
        // OBJ_DONT_REPARSE applies during the actual kernel name lookup.
        var text = new UnicodeName { Length = checked((ushort)(name.Length * 2)) };
        text.MaximumLength = text.Length;
        text.Buffer = Marshal.StringToHGlobalUni(name);
        try {
            var pinned = GCHandle.Alloc(text, GCHandleType.Pinned);
            try {
                var attr = new ObjectAttributes {
                    Length = Marshal.SizeOf(typeof(ObjectAttributes)), Root = parent.DangerousGetHandle(),
                    Name = pinned.AddrOfPinnedObject(), Flags = 0x40 | 0x1000
                };
                SafeFileHandle handle;
                IoStatus status;
                int result = NtOpenFile(out handle, Attributes | (directory ? Traverse : 0), ref attr,
                    out status, ShareAll, directory ? DirectoryFile : NonDirectoryFile);
                GC.KeepAlive(parent);
                if (result == 0 && !handle.IsInvalid) return handle;
                if (handle != null) handle.Dispose();
                // Only a missing name beneath the already verified root is an
                // observation. A missing root, offline volume or ACL failure is unknown.
                if (!directory && (result == unchecked((int)0xc0000034) ||
                    result == unchecked((int)0xc000003a) || result == unchecked((int)0xc000000f))) return null;
                throw new IOException();
            } finally { pinned.Free(); }
        } finally { Marshal.FreeHGlobal(text.Buffer); }
    }

    private static string Identity(SafeFileHandle file) {
        FileId id;
        if (!GetFileInformationByHandleEx(file, 18, out id, Marshal.SizeOf(typeof(FileId)))) throw new IOException();
        return String.Format(CultureInfo.InvariantCulture, "{0:x16}{1:x16}{2:x16}", id.Volume, id.Low, id.High);
    }

    public static string RootIdentity(string volume, string directory) {
        string name = RelativeName(directory);
        using (var drive = OpenVolume(volume))
        using (var root = OpenRelative(drive, name, true)) return Identity(root);
    }

    public static string Sample(string volume, string directory, string rootId, string relativeFile) {
        string name = RelativeName(directory);
        string leaf = RelativeName(relativeFile);
        using (var drive = OpenVolume(volume))
        using (var root = OpenRelative(drive, name, true)) {
            if (!String.Equals(Identity(root), rootId, StringComparison.Ordinal)) throw new IOException();
            using (var file = OpenRelative(root, leaf, false)) {
                if (file == null) return "absent";
                Information info;
                if (!GetFileInformationByHandle(file, out info) || info.Links != 1 ||
                    (info.Attributes & (uint)(FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device)) != 0)
                    throw new IOException();
                return String.Format(CultureInfo.InvariantCulture, "{0}:{1:x8}{2:x8}:{3:x8}{4:x8}",
                    Identity(file), info.SizeHigh, info.SizeLow, info.WriteHigh, info.WriteLow);
            }
        }
    }

    public static int Main(string[] args) {
        try {
            if (args.Length != 0) return 1;
            using (var input = Console.OpenStandardInput()) {
                var bytes = new byte[8193];
                int n = 0, take;
                while (n < bytes.Length && (take = input.Read(bytes, n, bytes.Length - n)) > 0) n += take;
                if (n == bytes.Length) return 1;
                string[] parts = new UTF8Encoding(false, true).GetString(bytes, 0, n).Split('\n');
                if (parts.Length != 4 || parts[2].Length != 48) return 1;
                Console.Write(Sample(parts[0], parts[1], parts[2], parts[3]));
                return 0;
            }
        } catch { return 1; }
    }
}
