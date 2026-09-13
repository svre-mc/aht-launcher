using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

// Loopback transport only. It cannot bind a process or declare it clean.
internal sealed class PhoenixProbeServer : IDisposable {
    const int MaximumConnections = 16, MaximumLineBytes = 256, RequestDeadlineMs = 1500;
    readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
    readonly HashSet<TcpClient> clients = new HashSet<TcpClient>();
    readonly object clientsGate = new object();
    readonly Func<string, string> respond;
    readonly Thread acceptThread;
    volatile bool stopping;

    public int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }

    public PhoenixProbeServer(Func<string, string> respond) {
        this.respond = respond;
        listener.Start(32);
        acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "Phoenix loopback" };
        acceptThread.Start();
    }

    void AcceptLoop() {
        while (!stopping) {
            TcpClient client = null;
            try {
                client = listener.AcceptTcpClient();
                lock (clientsGate) {
                    if (stopping || clients.Count >= MaximumConnections) { client.Close(); continue; }
                    clients.Add(client);
                }
                // Incomplete connections cannot monopolize the accept loop.
                TcpClient accepted = client;
                ThreadPool.QueueUserWorkItem(delegate { Process(accepted); });
            } catch {
                if (client != null) {
                    lock (clientsGate) clients.Remove(client);
                    client.Close();
                }
                if (!stopping) Thread.Sleep(10);
            }
        }
    }

    static string ReadRequest(TcpClient client, NetworkStream stream) {
        var clock = Stopwatch.StartNew();
        var bytes = new List<byte>(MaximumLineBytes);
        while (bytes.Count <= MaximumLineBytes) {
            long remaining = RequestDeadlineMs - clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new IOException();
            client.ReceiveTimeout = (int)remaining;
            int value = stream.ReadByte();
            if (value < 0) return null;
            if (value == 10) return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd('\r');
            bytes.Add((byte)value);
        }
        throw new InvalidDataException();
    }

    void Process(TcpClient client) {
        try {
            using (client) using (var stream = client.GetStream()) {
                client.SendTimeout = RequestDeadlineMs;
                string request = ReadRequest(client, stream);
                if (stopping || request == null) return;
                string response = respond(request);
                if (stopping || response == null) return;
                byte[] bytes = Encoding.UTF8.GetBytes(response + "\n");
                stream.Write(bytes, 0, bytes.Length);
            }
        } catch {
            // Bad transport is neither a clean measurement nor a cheating finding.
        } finally {
            lock (clientsGate) clients.Remove(client);
            client.Close();
        }
    }

    public void Dispose() {
        stopping = true;
        listener.Stop();
        lock (clientsGate) foreach (var client in clients) client.Close();
        if (Thread.CurrentThread != acceptThread) acceptThread.Join(2000);
    }
}

internal sealed class PhoenixProbeRateLimit {
    readonly object gate = new object();
    readonly Stopwatch clock = Stopwatch.StartNew();
    long nextRequest;

    public void Wait() {
        int delay;
        lock (gate) {
            long now = clock.ElapsedMilliseconds;
            long waiting = Math.Max(0, nextRequest - now);
            if (waiting > 1000) throw new IOException();
            delay = (int)waiting;
            nextRequest = Math.Max(now, nextRequest) + 100;
        }
        if (delay > 0) Thread.Sleep(delay);
    }
}
