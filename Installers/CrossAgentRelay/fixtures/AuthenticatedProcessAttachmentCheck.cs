using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Same-account qualification only. The worker can attach only to the two children it created.
internal static class AuthenticatedProcessAttachmentCheck
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);

    // PUBLIC_OBJECT_BASIC_INFORMATION has 14 ULONG fields, with HandleCount at index 2.
    [DllImport("ntdll.dll")]
    private static extern int NtQueryObject(SafeProcessHandle handle, int infoClass,
        [Out] uint[] basicInfo, int byteCount, out int returned);

    private static int HandleCount(SafeProcessHandle process)
    {
        var info = new uint[14];
        int size = info.Length * sizeof(uint), returned;
        if (NtQueryObject(process, 0, info, size, out returned) != 0 || returned != size)
            throw new IOException("Process object handle count unavailable.");
        return checked((int)info[2]);
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static Process Start(string args)
    {
        var info = new ProcessStartInfo(typeof(AuthenticatedProcessAttachmentCheck).Assembly.Location, args);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        return Process.Start(info);
    }

    private static string Creation(SafeProcessHandle handle)
    {
        return ProcessEndObservationFixture.CreationFileTime(handle).ToString(CultureInfo.InvariantCulture);
    }

    private static string Read(Stream pipe) { return CompletionChannel.Frame(pipe, Stream.Null); }

    private static void Write(Stream pipe, string frame)
    {
        var bytes = Encoding.ASCII.GetBytes(frame + "\n");
        pipe.Write(bytes, 0, bytes.Length);
        pipe.Flush();
    }

    private static string Apply(ProcessLeaseTable leases, Process[] children, string epoch, string frame)
    {
        var fields = frame.Split(' ');
        Guid id;
        if (fields.Length < 3 || fields[0] != epoch || !Guid.TryParseExact(fields[2], "N", out id))
            return "denied";
        if (fields.Length == 3 && fields[1] == "sample") return leases.Sample(id);
        if (fields.Length == 3 && fields[1] == "revoke") { leases.Revoke(id); return "revoked"; }
        if (fields.Length == 5 && fields[1] == "attach")
            foreach (var child in children)
                if (fields[3] == child.Id.ToString(CultureInfo.InvariantCulture))
                    return leases.Attach(id, child, fields[4], 15000);
        return "denied";
    }

    private static void ConnectWorker(string epoch, uint brokerPid, SecurityIdentifier sid, Process[] children)
    {
        using (var pipe = CompletionChannel.Connect("relay-process-check-" + epoch, sid)) {
            uint server;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out server) || server != brokerPid)
                throw new UnauthorizedAccessException("Unexpected fixture broker.");
            using (var leases = new ProcessLeaseTable(delegate(Guid id, int pid, string token) {
                return Array.Exists(children, child => child.Id == pid && Creation(child.SafeHandle) == token);
            })) {
                for (int n = 0; n < 32; n++) {
                    string frame;
                    try { frame = Read(pipe); } catch (IOException) { return; }
                    Write(pipe, Apply(leases, children, epoch, frame));
                }
            }
        }
    }

    private static void Worker(string gateName, uint brokerPid, SecurityIdentifier sid)
    {
        using (var first = Start("target " + gateName + "a"))
        using (var second = Start("target " + gateName + "b")) {
            var children = new[] { first, second };
            try {
                foreach (var child in children) {
                    Require(child.StandardOutput.ReadLine() == "ready", "Fixture child unavailable.");
                    Console.WriteLine(child.Id + " " + Creation(child.SafeHandle));
                }
                string epoch;
                while ((epoch = Console.ReadLine()) != null) {
                    Guid parsed;
                    Require(Guid.TryParseExact(epoch, "N", out parsed), "Invalid fixture epoch.");
                    ConnectWorker(epoch, brokerPid, sid, children);
                    Console.WriteLine("disconnected");
                }
            } finally {
                foreach (var child in children) child.StandardInput.Close();
                foreach (var child in children)
                    Require(child.WaitForExit(5000), "Fixture child cleanup failed.");
            }
        }
    }

    // The broker holds its own limited witness handle to the exact target for the entire trial.
    private sealed class Grant : IDisposable
    {
        private readonly SafeProcessHandle witness;
        private readonly long creation;
        public readonly string Binding;
        public readonly int Baseline;
        public string Attachment;
        public bool Revoked;

        public Grant(string ready)
        {
            var fields = ready.Split(' ');
            using (var child = Process.GetProcessById(Int32.Parse(fields[0], CultureInfo.InvariantCulture)))
                witness = ProcessEndObservationFixture.Open(child);
            creation = ProcessEndObservationFixture.CreationFileTime(witness);
            Require(fields.Length == 2 && creation.ToString(CultureInfo.InvariantCulture) == fields[1],
                "Wrong witness process.");
            Binding = ready;
            Baseline = HandleCount(witness);
        }

        public string Issue(string epoch)
        {
            if (Revoked || Observe(0) != "running") return null;
            Attachment = Guid.NewGuid().ToString("N");
            return epoch + " attach " + Attachment + " " + Binding;
        }

        public void Check(int extra)
        {
            Require(HandleCount(witness) == Baseline + extra, "Unexpected target handle count.");
        }

        public string Observe(uint waitMs) { return ProcessEndObservationFixture.Observe(witness, creation, waitMs); }
        public void Dispose() { witness.Dispose(); }
    }

    private static void Expect(Stream pipe, string frame, string expected)
    {
        Write(pipe, frame);
        Require(Read(pipe) == expected, "Unexpected " + frame.Split(' ')[1] + " outcome.");
    }

    private static void Exchange(Process worker, SecurityIdentifier sid, bool admit,
        Action<Stream, string> operations)
    {
        string epoch = Guid.NewGuid().ToString("N");
        using (var server = CompletionChannel.OpenServer("relay-process-check-" + epoch, sid, sid)) {
            worker.StandardInput.WriteLine(epoch);
            server.WaitForConnection();
            try {
                CompletionChannel.CheckClient(server, sid, delegate {
                    return admit && !worker.HasExited ? (uint)worker.Id : 0u;
                });
                Require(admit, "Unexpected client admission.");
                operations(server, epoch);
            } catch (UnauthorizedAccessException) { if (admit) throw; }
        }
        Require(worker.StandardOutput.ReadLine() == "disconnected", "Missing disconnect cleanup.");
    }

    private static void Broker(SecurityIdentifier sid)
    {
        string name = "Local\\relay-process-check-" + Guid.NewGuid().ToString("N");
        using (var endFirst = new EventWaitHandle(false, EventResetMode.ManualReset, name + "a"))
        using (var endSecond = new EventWaitHandle(false, EventResetMode.ManualReset, name + "b"))
        using (var worker = Start("worker " + name + " " + Process.GetCurrentProcess().Id)) {
            try {
                using (var first = new Grant(worker.StandardOutput.ReadLine()))
                using (var second = new Grant(worker.StandardOutput.ReadLine())) {
                    Exchange(worker, sid, false, null);
                    first.Check(0); second.Check(0);
                    string previous = null, previousId = null;
                    Exchange(worker, sid, true, delegate(Stream pipe, string epoch) {
                        previous = first.Issue(epoch);
                        previousId = first.Attachment;
                        Expect(pipe, previous, "attached");
                        Expect(pipe, second.Issue(epoch), "attached");
                        first.Check(1); second.Check(1);
                    });
                    first.Check(0); second.Check(0);
                    Exchange(worker, sid, true, delegate(Stream pipe, string epoch) {
                        Expect(pipe, previous, "denied");
                        Expect(pipe, epoch + " sample " + previousId, "unknown");
                        first.Check(0); second.Check(0);
                        Expect(pipe, first.Issue(epoch), "attached");
                        string secondFrame = second.Issue(epoch);
                        Expect(pipe, secondFrame, "attached");
                        first.Check(1); second.Check(1);
                        second.Revoked = true;
                        Expect(pipe, epoch + " revoke " + second.Attachment, "revoked");
                        Require(second.Issue(epoch) == null, "Revoked grant issued a fresh attachment.");
                        Expect(pipe, secondFrame, "duplicate");
                        first.Check(1); second.Check(0);
                        Expect(pipe, epoch + " sample " + second.Attachment, "unknown");
                        Expect(pipe, epoch + " sample " + first.Attachment, "running");
                        endFirst.Set(); endSecond.Set();
                        Require(first.Observe(5000) == "exit 259" && second.Observe(5000) == "exit 259",
                            "Witness did not observe both fixture exits.");
                        Require(first.Issue(epoch) == null, "Ended process received a fresh lease.");
                        Expect(pipe, epoch + " sample " + first.Attachment, "exit 259");
                        Expect(pipe, epoch + " sample " + second.Attachment, "unknown");
                    });
                }
            } finally {
                endFirst.Set(); endSecond.Set();
                worker.StandardInput.Close();
                Require(worker.WaitForExit(7000) && worker.ExitCode == 0, "Fixture worker cleanup failed.");
            }
        }
    }

    public static int Main(string[] args)
    {
        try {
            using (var deadline = new Timer(delegate { Environment.Exit(3); }, null, 30000, Timeout.Infinite))
            using (var identity = WindowsIdentity.GetCurrent()) {
                if (args.Length == 0) {
                    Broker(identity.User);
                    Console.WriteLine("Two authenticated connections to one worker and the same two fixture processes.");
                    Console.WriteLine("Wrong client PID and stale epoch denied. Disconnect released both observed handles.");
                    Console.WriteLine("Revocation released one handle. Peer observed exit 259; revoked grant returned unknown.");
                } else if (args.Length == 3 && args[0] == "worker") {
                    Worker(args[1], UInt32.Parse(args[2], CultureInfo.InvariantCulture), identity.User);
                } else if (args.Length == 2 && args[0] == "target") {
                    using (var gate = EventWaitHandle.OpenExisting(args[1])) {
                        Console.WriteLine("ready");
                        return gate.WaitOne(20000) ? 259 : 94;
                    }
                } else return 2;
            }
            return 0;
        } catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
    }
}
