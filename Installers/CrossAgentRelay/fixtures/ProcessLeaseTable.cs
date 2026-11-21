using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Qualification only. The guard checks a fixed local authorization on the caller's thread.
public sealed class ProcessLeaseTable : IDisposable
{
    private sealed class Lease
    {
        public long Deadline;
        public long Creation;
        public SafeProcessHandle Handle;
        public bool Admitted;
    }

    private readonly object sync = new object();
    private readonly Dictionary<Guid, Lease> leases = new Dictionary<Guid, Lease>();
    private readonly HashSet<Guid> reserved = new HashSet<Guid>();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly Func<Guid, int, string, bool> allowed;
    private readonly Timer timer;
    private bool disposed;
    private int attempts, opened, closed;

    public ProcessLeaseTable(Func<Guid, int, string, bool> allowed)
    {
        if (allowed == null) throw new ArgumentNullException("allowed");
        this.allowed = allowed;
        timer = new Timer(Expire, null, 25, 25);
    }

    public int Opened { get { lock (sync) return opened; } }
    public int Attempts { get { lock (sync) return attempts; } }
    public int Closed { get { lock (sync) return closed; } }

    public static bool ValidCreation(string text)
    {
        ulong value;
        return text != null && text.Length <= 20 &&
            UInt64.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value) &&
            value != 0 && text == value.ToString(CultureInfo.InvariantCulture);
    }

    public string Attach(Guid id, Process child, string creation, int leaseMs)
    {
        if (id == Guid.Empty || child == null || !ValidCreation(creation) || leaseMs < 1 || leaseMs > 30000) return "invalid";
        int pid = child.Id;
        Lease lease;
        lock (sync)
        {
            if (disposed) return "unavailable";
            if (reserved.Contains(id)) return "duplicate";
            // Retain used IDs for this table lifetime. Refuse new ones instead of evicting old ones.
            if (leases.Count >= 2 || reserved.Count >= 64) return "full";
            lease = new Lease { Deadline = clock.ElapsedMilliseconds + leaseMs };
            leases.Add(id, lease);
            reserved.Add(id);
        }
        bool authorized = false;
        try
        {
            authorized = allowed(id, pid, creation);
            if (!authorized) return "denied";
            lock (sync)
            {
                if (!leases.ContainsKey(id) || clock.ElapsedMilliseconds >= lease.Deadline) return "unknown";
                attempts++;
                lease.Handle = ProcessEndObservationFixture.Open(child);
                opened++;
                lease.Creation = ProcessEndObservationFixture.CreationFileTime(lease.Handle);
                if (unchecked((ulong)lease.Creation).ToString(CultureInfo.InvariantCulture) != creation) return "unknown";
            }
            // A stalled authority check cannot prevent the timer or a revocation from closing this handle.
            if (!allowed(id, pid, creation)) return "unknown";
            lock (sync)
            {
                if (!leases.ContainsKey(id) || clock.ElapsedMilliseconds >= lease.Deadline) return "unknown";
                lease.Admitted = true;
                return "attached";
            }
        }
        catch (Win32Exception) { return "unknown"; }
        finally
        {
            lock (sync)
            {
                if (!lease.Admitted && leases.ContainsKey(id))
                {
                    Close(id);
                    if (!authorized) reserved.Remove(id);
                }
            }
        }
    }

    public string Sample(Guid id)
    {
        lock (sync)
        {
            Lease lease;
            if (!leases.TryGetValue(id, out lease) || !lease.Admitted) return "unknown";
            if (clock.ElapsedMilliseconds < lease.Deadline)
            {
                string state = ProcessEndObservationFixture.Observe(lease.Handle, lease.Creation, 0);
                if (clock.ElapsedMilliseconds < lease.Deadline) return state;
            }
            Close(id);
            return "unknown";
        }
    }

    private void Close(Guid id)
    {
        Lease lease;
        if (!leases.TryGetValue(id, out lease)) return;
        leases.Remove(id);
        if (lease.Handle != null)
        {
            lease.Handle.Dispose();
            closed++;
        }
    }

    public void Revoke(Guid id) { lock (sync) Close(id); }

    private void Expire(object unused)
    {
        lock (sync)
        {
            if (leases.Count == 0) return;
            foreach (Guid id in new List<Guid>(leases.Keys))
                if (clock.ElapsedMilliseconds >= leases[id].Deadline) Close(id);
        }
    }

    public void Dispose()
    {
        lock (sync)
        {
            if (disposed) return;
            disposed = true;
            timer.Dispose();
            foreach (Guid id in new List<Guid>(leases.Keys)) Close(id);
        }
    }
}
