using System;
using System.Collections.Generic;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessId(IntPtr handle);

    // Record the exact handle opened by the lease table. A managed reference does not duplicate
    // the native handle or prevent its owner from explicitly disposing it.
    private sealed class OpenedHandle
    {
        private readonly SafeProcessHandle handle;
        private readonly IntPtr value;
        public readonly uint Target;
        private bool checkedClosure;

        public OpenedHandle(SafeProcessHandle handle)
        {
            this.handle = handle;
            value = handle.DangerousGetHandle();
            Target = GetProcessId(value);
            Require(Target != 0, "Cannot identify fixture lease handle.");
        }

        public bool IsLive()
        {
            if (checkedClosure) return false;
            uint target = GetProcessId(value);
            int error = Marshal.GetLastWin32Error();
            if (!handle.IsClosed) {
                Require(target == Target, "Open lease handle no longer identifies the fixture target.");
                return true;
            }
            // Verify each close before a new attachment may reuse this numeric slot.
            Require(target != Target && (target != 0 || error == 6 /* ERROR_INVALID_HANDLE */),
                "Native fixture handle closure unconfirmed.");
            checkedClosure = true;
            return false;
        }
    }

    private static string HandleEvidence(List<OpenedHandle> handles, Process[] children)
    {
        int first = 0, second = 0;
        foreach (var handle in handles) {
            if (!handle.IsLive()) continue;
            if (handle.Target == children[0].Id) first++;
            else if (handle.Target == children[1].Id) second++;
            else throw new InvalidOperationException("Unexpected process in fixture lease table.");
        }
        return handles.Count + " " + first + " " + second;
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

    private static string Apply(ProcessLeaseTable leases, Process[] children, string epoch, string frame, int leaseMs)
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
                    return leases.Attach(id, child, fields[4], leaseMs);
        return "denied";
    }

    private static int ConnectWorker(string epoch, uint brokerPid, SecurityIdentifier sid, Process[] children,
        List<OpenedHandle> handles, int leaseMs)
    {
        using (var pipe = CompletionChannel.Connect("relay-process-check-" + epoch, sid)) {
            uint server;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out server) || server != brokerPid)
                throw new UnauthorizedAccessException("Unexpected fixture broker.");
            var leases = new ProcessLeaseTable(delegate(Guid id, int pid, string token) {
                return Array.Exists(children, child => child.Id == pid && Creation(child.SafeHandle) == token);
            }, handle => handles.Add(new OpenedHandle(handle)));
            using (leases) {
                for (int n = 0; ; n++) {
                    string frame;
                    try { frame = Read(pipe); } catch (IOException) { break; }
                    Require(n < 32, "Fixture frame limit exceeded.");
                    Write(pipe, frame == epoch + " handles" ? HandleEvidence(handles, children) :
                        Apply(leases, children, epoch, frame, leaseMs));
                }
            }
            return leases.LiveClosedByDispose;
        }
    }

    private static void Worker(string gateName, uint brokerPid, SecurityIdentifier sid, Func<string, Process> launch,
        int leaseMs = 15000)
    {
        using (var endFirst = EventWaitHandle.OpenExisting(gateName + "a"))
        using (var endSecond = EventWaitHandle.OpenExisting(gateName + "b")) {
            var children = new Process[2];
            var handles = new List<OpenedHandle>();
            try {
                children[0] = launch("target " + gateName + "a");
                children[1] = launch("target " + gateName + "b");
                foreach (var child in children) {
                    Require(child.StandardOutput.ReadLine() == "ready", "Fixture child unavailable.");
                    Console.WriteLine(child.Id + " " + Creation(child.SafeHandle));
                }
                string epoch;
                while ((epoch = Console.ReadLine()) != null) {
                    Guid parsed;
                    Require(Guid.TryParseExact(epoch, "N", out parsed), "Invalid fixture epoch.");
                    int released = ConnectWorker(epoch, brokerPid, sid, children, handles, leaseMs);
                    Console.WriteLine(HandleEvidence(handles, children));
                    Console.WriteLine(released);
                }
            } finally {
                endFirst.Set(); endSecond.Set();
                bool joined = true;
                foreach (var child in children) {
                    if (child == null) continue;
                    using (child) {
                        child.StandardInput.Close();
                        joined &= child.WaitForExit(5000);
                    }
                }
                Require(joined, "Fixture child cleanup failed.");
            }
        }
    }

    private static void CheckPartialStartup(SecurityIdentifier sid)
    {
        string name = "Local\\relay-process-check-" + Guid.NewGuid().ToString("N");
        using (var endFirst = new EventWaitHandle(false, EventResetMode.ManualReset, name + "a"))
        using (var endSecond = new EventWaitHandle(false, EventResetMode.ManualReset, name + "b")) {
            Process first = null;
            SafeProcessHandle witness = null;
            long creation = 0;
            var failure = new IOException("Fixture second launch failed.");
            try {
                try {
                    Worker(name, 0, sid, delegate(string args) {
                        if (first == null) { first = Start(args); return first; }
                        witness = ProcessEndObservationFixture.Open(first);
                        creation = ProcessEndObservationFixture.CreationFileTime(witness);
                        throw failure;
                    });
                    throw new InvalidOperationException("Missing second launch failure.");
                } catch (IOException ex) { if (ex != failure) throw; }
                Require(ProcessEndObservationFixture.Observe(witness, creation, 0) == "exit 259",
                    "First target was still running after the second launch failed.");
            } finally {
                endFirst.Set(); endSecond.Set();
                if (witness != null) using (witness)
                    Require(ProcessEndObservationFixture.Observe(witness, creation, 5000) == "exit 259",
                        "Partial-start control cleanup failed.");
            }
        }
    }

    // The broker holds its own limited witness handle to the exact target for the entire trial.
    private sealed class Grant : IDisposable
    {
        private readonly SafeProcessHandle witness;
        private readonly long creation;
        public readonly string Binding;
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
        }

        public string Issue(string epoch)
        {
            if (Revoked || Observe(0) != "running") return null;
            Attachment = Guid.NewGuid().ToString("N");
            return epoch + " attach " + Attachment + " " + Binding;
        }

        public SafeProcessHandle AdditionalObserver()
        {
            using (var child = Process.GetProcessById(Int32.Parse(Binding.Split(' ')[0], CultureInfo.InvariantCulture)))
                return ProcessEndObservationFixture.Open(child);
        }
        public string Observe(uint waitMs) { return ProcessEndObservationFixture.Observe(witness, creation, waitMs); }
        public void Dispose() { witness.Dispose(); }
    }

    private static void Expect(Stream pipe, string frame, string expected)
    {
        Write(pipe, frame);
        Require(Read(pipe) == expected, "Unexpected " + frame.Split(' ')[1] + " outcome.");
    }

    private static void CheckEvidence(string phase, string expected, string observed)
    {
        if (observed == null || !System.Text.RegularExpressions.Regex.IsMatch(observed, @"\A\d{1,2} \d{1,2} \d{1,2}\z"))
            observed = "missing or invalid evidence";
        Require(observed == expected, phase + " (opens, first live, second live): expected " +
            expected + ", observed " + observed + ".");
    }

    private static void CheckLive(Stream pipe, string epoch, string phase, string expected)
    {
        Write(pipe, epoch + " handles");
        CheckEvidence(phase, expected, Read(pipe));
    }

    private sealed class InconclusiveDisconnect : Exception
    {
        public readonly int Expected, Observed;
        public InconclusiveDisconnect(int expected, int observed) : base(
            "Expected " + expected + " live leases released at disconnect, observed " + observed + ".")
        { Expected = expected; Observed = observed; }
    }

    private static void Exchange(Process worker, SecurityIdentifier sid, bool admit, string afterDisconnect,
        int expectedReleased, Action<Stream, string> operations)
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
        CheckEvidence("disconnect cleanup", afterDisconnect, worker.StandardOutput.ReadLine());
        int released;
        Require(Int32.TryParse(worker.StandardOutput.ReadLine(), NumberStyles.None, CultureInfo.InvariantCulture,
            out released) && released <= 2, "Missing disconnect closure count.");
        if (released != expectedReleased) throw new InconclusiveDisconnect(expectedReleased, released);
    }

    private static void Broker(SecurityIdentifier sid, bool expireBeforeDisconnect)
    {
        string name = "Local\\relay-process-check-" + Guid.NewGuid().ToString("N");
        using (var endFirst = new EventWaitHandle(false, EventResetMode.ManualReset, name + "a"))
        using (var endSecond = new EventWaitHandle(false, EventResetMode.ManualReset, name + "b"))
        using (var worker = Start((expireBeforeDisconnect ? "worker-expiry " : "worker ") + name + " " +
            Process.GetCurrentProcess().Id)) {
            try {
                using (var first = new Grant(worker.StandardOutput.ReadLine()))
                using (var second = new Grant(worker.StandardOutput.ReadLine())) {
                    Exchange(worker, sid, false, "0 0 0", 0, null);
                    string previous = null, previousId = null;
                    Exchange(worker, sid, true, "2 0 0", 2, delegate(Stream pipe, string epoch) {
                        previous = first.Issue(epoch);
                        previousId = first.Attachment;
                        Expect(pipe, previous, "attached");
                        Expect(pipe, second.Issue(epoch), "attached");
                        CheckLive(pipe, epoch, "first attachment", "2 1 1");
                        if (expireBeforeDisconnect) {
                            string counts = null;
                            for (int i = 0; i < 20 && counts != "2 0 0"; i++) {
                                Thread.Sleep(125);
                                Write(pipe, epoch + " handles");
                                counts = Read(pipe);
                            }
                            CheckEvidence("expiry on open connection", "2 0 0", counts);
                        }
                    });
                    Require(!expireBeforeDisconnect, "Expired leases counted toward disconnect.");
                    Exchange(worker, sid, true, "4 0 0", 1, delegate(Stream pipe, string epoch) {
                        Expect(pipe, previous, "denied");
                        Expect(pipe, epoch + " sample " + previousId, "unknown");
                        CheckLive(pipe, epoch, "stale request", "2 0 0");
                        Expect(pipe, first.Issue(epoch), "attached");
                        string secondFrame = second.Issue(epoch);
                        Expect(pipe, secondFrame, "attached");
                        CheckLive(pipe, epoch, "fresh attachment", "4 1 1");
                        second.Revoked = true;
                        using (var observer = second.AdditionalObserver()) {
                            Expect(pipe, epoch + " revoke " + second.Attachment, "revoked");
                            Require(second.Issue(epoch) == null, "Revoked grant issued a fresh attachment.");
                            Expect(pipe, secondFrame, "duplicate");
                            CheckLive(pipe, epoch, "revocation with independent observer", "4 1 0");
                            Require(second.Observe(0) == "running", "Revoked fixture target ended prematurely.");
                        }
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
                    CheckPartialStartup(identity.User);
                    try { Broker(identity.User, true); }
                    catch (InconclusiveDisconnect ex) {
                        if (ex.Expected != 2 || ex.Observed != 0) throw;
                        Console.WriteLine("Expiry control was inconclusive as required. " + ex.Message);
                    }
                    Broker(identity.User, false);
                    Console.WriteLine("Partial startup joined its one child. Early expiry excluded from disconnect evidence.");
                    Console.WriteLine("Two authenticated connections to one worker and the same two fixture processes.");
                    Console.WriteLine("Wrong client PID and stale epoch denied. Disconnect released both observed handles.");
                    Console.WriteLine("Worker lease handles: 4 opens; 1 live after revocation; 0 live after final disconnect.");
                    Console.WriteLine("Broker witnesses observed both exits at 259. Live grant reported 259; revoked grant returned unknown.");
                } else if (args.Length == 3 && (args[0] == "worker" || args[0] == "worker-expiry")) {
                    Worker(args[1], UInt32.Parse(args[2], CultureInfo.InvariantCulture), identity.User, Start,
                        args[0] == "worker" ? 15000 : 1000);
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
