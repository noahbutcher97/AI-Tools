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
        public bool Revoked;
    }

    private readonly object sync = new object();
    private readonly Dictionary<Guid, Lease> leases = new Dictionary<Guid, Lease>();
    private readonly Dictionary<Guid, Lease> reserved = new Dictionary<Guid, Lease>();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly Func<Guid, int, string, bool> allowed;
    private readonly Action<SafeProcessHandle> observeOpen;
    private readonly Timer timer;
    private bool disposed;
    private int attempts, opened, closed;

    public ProcessLeaseTable(Func<Guid, int, string, bool> allowed)
        : this(allowed, null) {}

    internal ProcessLeaseTable(Func<Guid, int, string, bool> allowed, Action<SafeProcessHandle> observeOpen)
    {
        if (allowed == null) throw new ArgumentNullException("allowed");
        this.allowed = allowed;
        this.observeOpen = observeOpen;
        timer = new Timer(Expire, null, 25, 25);
    }

    public int Opened { get { lock (sync) return opened; } }
    public int Attempts { get { lock (sync) return attempts; } }
    public int Closed { get { lock (sync) return closed; } }
    public int ActiveSlots { get { lock (sync) return leases.Count; } }

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
            if (reserved.ContainsKey(id)) return "duplicate";
            // Retain used IDs for this table lifetime. Refuse new ones instead of evicting old ones.
            if (leases.Count >= 2 || reserved.Count >= 64) return "full";
            lease = new Lease { Deadline = clock.ElapsedMilliseconds + leaseMs };
            leases.Add(id, lease);
            reserved.Add(id, lease);
        }
        bool authorized = false;
        try
        {
            authorized = allowed(id, pid, creation);
            if (!authorized) return "denied";
            lock (sync)
            {
                if (!IsActive(id, lease) || clock.ElapsedMilliseconds >= lease.Deadline) return "unknown";
                attempts++;
                lease.Handle = ProcessEndObservationFixture.Open(child);
                opened++;
                if (observeOpen != null) observeOpen(lease.Handle);
                lease.Creation = ProcessEndObservationFixture.CreationFileTime(lease.Handle);
                if (unchecked((ulong)lease.Creation).ToString(CultureInfo.InvariantCulture) != creation) return "unknown";
            }
            // A stalled authority check cannot prevent the timer or a revocation from closing this handle.
            if (!allowed(id, pid, creation)) return "unknown";
            lock (sync)
            {
                if (!IsActive(id, lease) || clock.ElapsedMilliseconds >= lease.Deadline) return "unknown";
                lease.Admitted = true;
                return "attached";
            }
        }
        catch (Win32Exception) { return "unknown"; }
        finally
        {
            lock (sync)
            {
                if (!lease.Admitted && IsActive(id, lease)) Close(id);
                Lease owner;
                if (!authorized && !lease.Revoked && reserved.TryGetValue(id, out owner) && owner == lease)
                    reserved.Remove(id);
            }
        }
    }

    private bool IsActive(Guid id, Lease expected)
    {
        Lease current;
        return leases.TryGetValue(id, out current) && current == expected;
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
            lease.Handle = null;
            closed++;
        }
    }

    public void Revoke(Guid id)
    {
        lock (sync)
        {
            Lease lease;
            if (reserved.TryGetValue(id, out lease)) lease.Revoked = true;
            Close(id);
        }
    }

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
