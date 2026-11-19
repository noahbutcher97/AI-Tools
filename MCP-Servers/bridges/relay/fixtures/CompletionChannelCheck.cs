using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Threading;

internal static class CompletionChannelCheck {
    private static SecurityIdentifier Current() {
        using (var id = WindowsIdentity.GetCurrent()) return id.User;
    }

    private static void Probe(string mode) {
        var name = "relay-test-" + Guid.NewGuid().ToString("N");
        var me = Current();
        var different = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
        using (var server = CompletionChannel.OpenServer(name, me, me)) {
            var info = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "client " + name + " " + mode);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            using (var child = Process.Start(info)) {
                server.WaitForConnection();
                bool checkedPeer = false;
                try {
                    CompletionChannel.CheckClient(server, mode == "wrong-sid" ? different : me,
                        delegate { return mode == "wrong-pid" ? (uint)Process.GetCurrentProcess().Id : (uint)child.Id; });
                    checkedPeer = true;
                    server.WriteByte(89);
                    server.Flush();
                } catch (Exception ex) {
                    if (!(ex is UnauthorizedAccessException) && !(ex is IOException)) throw;
                } finally { server.Dispose(); }
                if (!child.WaitForExit(3000) || checkedPeer != (mode == "valid") || child.ExitCode != 0)
                    throw new Exception("unexpected peer admission " + mode);
            }
        }
    }

    public static int Main(string[] args) {
        using (var deadline = new Timer(delegate { Environment.Exit(3); },null,12000,Timeout.Infinite)) {
            if (args.Length == 0) {
                using (var identity = WindowsIdentity.GetCurrent()) {
                    var network = new SecurityIdentifier(WellKnownSidType.NetworkSid, null);
                    if (new WindowsPrincipal(identity).IsInRole(network)) {
                        string name = "relay-test-" + Guid.NewGuid().ToString("N");
                        using (var pipe = CompletionChannel.OpenServer(name, identity.User, identity.User)) {
                            try { using (CompletionChannel.Connect(name, identity.User)) {} return 1; }
                            catch (UnauthorizedAccessException) {}
                        }
                    } else foreach (var mode in new string[] {"valid","wrong-sid","wrong-pid","wrong-owner"}) Probe(mode);
                }
                var good = "O:BAG:BAD:(A;;FA;;;BA)(A;;GRGX;;;BU)";
                CompletionChannel.CheckTaskAcl(good);
                foreach (var bad in new string[] {"O:BUG:BAD:(A;;FA;;;BA)","O:BAG:BAD:(A;;GW;;;BU)"}) {
                    try { CompletionChannel.CheckTaskAcl(bad); return 1; } catch (UnauthorizedAccessException) {}
                }
                return 0;
            }
            try {
                var owner = args[2] == "wrong-owner" ? new SecurityIdentifier(WellKnownSidType.WorldSid,null) : Current();
                using (var client = CompletionChannel.Connect(args[1], owner)) {
                    bool gotData = client.ReadByte() == 89;
                    return gotData == (args[2] == "valid") && args[2] != "wrong-owner" ? 0 : 1;
                }
            } catch (UnauthorizedAccessException) { return args[2] == "wrong-owner" ? 0 : 1; }
        }
    }
}
