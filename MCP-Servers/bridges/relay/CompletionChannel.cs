using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Compile with the Windows .NET Framework compiler. Install the native helper,
// runtime and JS files under the same administrator-controlled relay root.
internal static class CompletionChannel {
    internal const string TaskName = "CrossAgentRelayCompletionWorker";
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly string Image = Path.Combine(Root, "CompletionChannel.exe");
    // Task Scheduler retains only the exit code for a noninteractive action.
    private static int failureStage = 1;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle handle, out uint pid);

    internal static NamedPipeServerStream OpenServer(string name, SecurityIdentifier broker, SecurityIdentifier worker) {
        var acl = new PipeSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.SetOwner(broker);
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
            PipeAccessRights.FullControl, AccessControlType.Deny));
        acl.AddAccessRule(new PipeAccessRule(broker, PipeAccessRights.FullControl, AccessControlType.Allow));
        var access = PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadPermissions |
            PipeAccessRights.Synchronize;
        acl.AddAccessRule(new PipeAccessRule(worker, access, AccessControlType.Allow));
        return new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 16384, 16384, acl);
    }

    internal static NamedPipeClientStream Connect(string name, SecurityIdentifier broker) {
        var rights = PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadPermissions |
            PipeAccessRights.Synchronize;
        var pipe = new NamedPipeClientStream(".", name, rights, PipeOptions.None,
            TokenImpersonationLevel.Identification, HandleInheritability.None);
        try {
            pipe.Connect(5000);
            if (!broker.Equals(pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)))) throw new UnauthorizedAccessException();
            pipe.WriteByte(72);
            pipe.Flush();
            return pipe;
        } catch { pipe.Dispose(); throw; }
    }

    internal static void CheckClient(NamedPipeServerStream pipe, SecurityIdentifier expectedSid, Func<uint> runningPid) {
        uint pid;
        if (pipe.ReadByte() != 72 || !GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) ||
                pid == 0 || pid != runningPid()) throw new UnauthorizedAccessException();
        SecurityIdentifier actual = null;
        pipe.RunAsClient(delegate {
            using (var who = WindowsIdentity.GetCurrent(true)) { if (who != null) actual = who.User; }
        });
        if (!expectedSid.Equals(actual)) throw new UnauthorizedAccessException();
    }

    internal static string Frame(Stream input, Stream output) {
        using (var bytes = new MemoryStream()) {
            for (;;) {
                int value = input.ReadByte();
                if (value < 0 || bytes.Length > 12288) throw new IOException();
                if (value == 10) break;
                bytes.WriteByte((byte)value);
            }
            byte[] frame = bytes.ToArray();
            string text = Utf8.GetString(frame);
            output.Write(frame, 0, frame.Length);
            output.WriteByte(10);
            output.Flush();
            return text;
        }
    }

    private static void Exchange(Stream requests, Stream requestDest, Stream replies, Stream replyDest) {
        for (int i = 0; i < 3; i++) {
            Frame(requests, requestDest);
            string reply = Frame(replies, replyDest);
            if (reply.StartsWith("{\"op\":\"done\",", StringComparison.Ordinal) || reply == "{\"op\":\"failed\"}") return;
        }
        throw new IOException();
    }

    private static SecurityIdentifier Sid(string value) {
        if (value.StartsWith("S-1-", StringComparison.Ordinal)) return new SecurityIdentifier(value);
        return (SecurityIdentifier)new NTAccount(value).Translate(typeof(SecurityIdentifier));
    }

    internal static void CheckTaskAcl(string sddl) {
        var sd = new RawSecurityDescriptor(sddl);
        var admin = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        if ((!admin.Equals(sd.Owner) && !system.Equals(sd.Owner)) || sd.DiscretionaryAcl == null)
            throw new UnauthorizedAccessException();
        foreach (GenericAce entry in sd.DiscretionaryAcl) {
            var ace = entry as CommonAce;
            if (ace == null || ace.IsCallback) throw new UnauthorizedAccessException();
            if (ace.AceQualifier == AceQualifier.AccessDenied || admin.Equals(ace.SecurityIdentifier) || system.Equals(ace.SecurityIdentifier)) continue;
            // Permit read/execute only for any other account, including the broker.
            const uint readExecute = 0xA01200A9;
            if (ace.AceQualifier != AceQualifier.AccessAllowed || ((uint)ace.AccessMask & ~readExecute) != 0)
                throw new UnauthorizedAccessException();
        }
    }

    private static void Serve(SecurityIdentifier broker, SecurityIdentifier worker, Stream requests, Stream replies) {
        failureStage = 10;
        string nonce = Guid.NewGuid().ToString("N");
        using (var pipe = OpenServer("CrossAgentRelay-" + nonce, broker, worker)) {
            dynamic scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true));
            scheduler.Connect();
            dynamic task = scheduler.GetFolder("\\").GetTask(TaskName);
            failureStage = 11;
            CheckTaskAcl((string)task.GetSecurityDescriptor(7));
            dynamic def = task.Definition;
            if (!worker.Equals(Sid((string)def.Principal.UserId)) || def.Principal.LogonType != 3 ||
                    def.Principal.RunLevel != 0 || def.Actions.Count != 1 || def.Triggers.Count != 0)
                throw new UnauthorizedAccessException();
            dynamic action = def.Actions.Item(1);
            if (action.Type != 0 || !String.Equals((string)action.Path, Image, StringComparison.OrdinalIgnoreCase) ||
                    action.Arguments != "worker $(Arg0)" || !String.Equals((string)action.WorkingDirectory, Root, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException();
            failureStage = 12;
            dynamic running = task.Run(nonce);
            failureStage = 13;
            var pending = pipe.BeginWaitForConnection(null, null);
            using (var wait = pending.AsyncWaitHandle) {
                if (!wait.WaitOne(7000)) throw new TimeoutException();
                pipe.EndWaitForConnection(pending);
            }
            failureStage = 14;
            CheckClient(pipe, worker, delegate { running.Refresh(); return running.State == 4 ? (uint)running.EnginePID : 0u; });
            failureStage = 15;
            Exchange(requests, pipe, pipe, replies);
        }
    }

    private static void Work(string nonce, SecurityIdentifier broker) {
        failureStage = 30;
        Guid parsed;
        if (!Guid.TryParseExact(nonce, "N", out parsed) || parsed.ToString("N") != nonce) throw new ArgumentException();
        failureStage = 31;
        using (var pipe = Connect("CrossAgentRelay-" + nonce, broker)) {
            failureStage = 32;
            var info = new ProcessStartInfo(Path.Combine(Root, "runtime", "node.exe"), "completion-worker.mjs");
            info.WorkingDirectory = Path.Combine(Root, "relay");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            // The interactive profile supplies provider sign-in. Runtime hooks,
            // agent-session identity and alternate provider homes are excluded.
            info.EnvironmentVariables.Clear();
            foreach (var key in new string[] {"SystemRoot","USERPROFILE","APPDATA","LOCALAPPDATA","TEMP","TMP","HOMEDRIVE","HOMEPATH","USERNAME","USERDOMAIN"}) {
                var value = Environment.GetEnvironmentVariable(key);
                if (value != null) info.EnvironmentVariables[key] = value;
            }
            info.EnvironmentVariables["PATH"] = Path.Combine(Root,"provider") + ";" + Environment.SystemDirectory;
            using (var child = Process.Start(info)) {
                failureStage = 33;
                try { Exchange(pipe, child.StandardInput.BaseStream, child.StandardOutput.BaseStream, pipe); }
                finally {
                    child.StandardInput.Close();
                    if (!child.WaitForExit(3000)) child.Kill();
                }
            }
        }
    }

    public static int Main(string[] args) {
        try {
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(
                File.ReadAllText(Path.Combine(Root,"completion-principals.json")));
            var broker = new SecurityIdentifier(config["brokerSid"]);
            var worker = new SecurityIdentifier(config["sessionSid"]);
            using (var identity = WindowsIdentity.GetCurrent())
            using (var deadline = new Timer(delegate { Environment.Exit(2); }, null, 55000, Timeout.Infinite)) {
                if (broker.Equals(worker) || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                    throw new UnauthorizedAccessException();
                if (args.Length == 1 && args[0] == "broker" && broker.Equals(identity.User))
                    Serve(broker, worker, Console.OpenStandardInput(), Console.OpenStandardOutput());
                else if (args.Length == 1 && args[0] == "qualify" && broker.Equals(identity.User)) {
                    using (var input = new MemoryStream(Utf8.GetBytes("{\"op\":\"check\"}\n")))
                    using (var output = new MemoryStream()) {
                        Serve(broker, worker, input, output);
                        if (Utf8.GetString(output.ToArray()) != "{\"op\":\"done\",\"state\":\"ready\"}\n")
                            throw new IOException();
                    }
                }
                else if (args.Length == 2 && args[0] == "worker" && worker.Equals(identity.User) &&
                        Process.GetCurrentProcess().SessionId > 0) Work(args[1], broker);
                else throw new UnauthorizedAccessException();
            }
            return 0;
        } catch { Console.Error.WriteLine("Completion channel unavailable."); return failureStage; }
    }
}
