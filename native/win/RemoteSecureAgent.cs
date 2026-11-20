// Featured App — Remote Desktop lock-screen agent (Windows).
//
// A normal app cannot see or control the Windows lock screen: it runs on a
// separate, protected desktop that only SYSTEM processes in the user's session
// may open. This agent is installed once with administrator approval
// (Remote Desktop → Security → Lock screen access) and works like the services
// of AnyDesk / RustDesk:
//
//   service mode   scheduled task, SYSTEM, session 0. Keeps one "session mode"
//                  copy of itself running in the active console session
//                  (SYSTEM token moved to that session), restarting it when the
//                  user changes.
//   session mode   named pipe \\.\pipe\featured-remote-secure for the app
//                  (interactive users only). While — and ONLY while — the
//                  session is locked it captures the input desktop (the lock
//                  screen) and injects keyboard/mouse into it. Unlocked, it
//                  refuses everything but "status", so it can never be used to
//                  click a UAC prompt or act on an unlocked desktop.
//
// Pipe protocol, one ASCII line per command:
//   ping                       -> pong
//   status                     -> locked | unlocked
//   frame MAXWIDTH QUALITY     -> frame W H BASE64JPEG | noframe
//   m NX NY                    move (NX, NY = 0..1 of the whole virtual screen)
//   d B NX NY / u B NX NY      button B down / up (0 left, 1 middle, 2 right)
//   w DX DY                    wheel, browser pixels (+DY = down)
//   k SC 1|0                   key by set-1 scan code (0xE0xx = extended)
//   t HEX                      text, UTF-16 code units (4 hex digits each)
//   sas                        Ctrl+Alt+Delete (needs the SoftwareSASGeneration policy)
//   r                          release every key / button
//
// C# 5 only: Windows PowerShell 5.1's Add-Type compiler.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class FeaturedSecureAgent
{
    public const string PipeName = "featured-remote-secure";

    // ── Win32 ───────────────────────────────────────────────────────────────

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes, int impersonationLevel, int tokenType, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, int length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQuerySessionInformation(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("sas.dll")] static extern void SendSAS(bool asUser);

    const uint TOKEN_ALL_ACCESS = 0xF01FF;
    const uint MAXIMUM_ALLOWED = 0x02000000;
    const int SECURITY_IMPERSONATION = 2;
    const int TOKEN_PRIMARY = 1;
    const int TOKEN_SESSION_ID = 12;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint GENERIC_ALL = 0x10000000;
    const int WTS_SESSION_INFO_EX = 25;
    const uint NO_SESSION = 0xFFFFFFFF;

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOVE = 0x1, LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, MIDDLEDOWN = 0x20, MIDDLEUP = 0x40;
    const uint WHEEL = 0x800, HWHEEL = 0x1000, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
    const uint KEY_EXTENDED = 0x1, KEY_UP = 0x2, KEY_UNICODE = 0x4, KEY_SCANCODE = 0x8;

    // ── service mode (session 0) ────────────────────────────────────────────

    /// Keeps a session-mode copy running in the active console session.
    public static void RunService(string scriptPath)
    {
        Process child = null;
        uint childSession = NO_SESSION;
        for (;;)
        {
            try
            {
                uint session = WTSGetActiveConsoleSessionId();
                bool alive = child != null && !child.HasExited;
                if (session != NO_SESSION && session != 0 && (!alive || session != childSession))
                {
                    if (alive)
                    {
                        try { child.Kill(); } catch (Exception) { }
                    }
                    child = SpawnInSession(session, scriptPath);
                    childSession = session;
                }
            }
            catch (Exception) { }
            Thread.Sleep(2000);
        }
    }

    static Process SpawnInSession(uint session, string scriptPath)
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out token)) return null;
        IntPtr copy = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(token, MAXIMUM_ALLOWED, IntPtr.Zero, SECURITY_IMPERSONATION, TOKEN_PRIMARY, out copy)) return null;
            // Same SYSTEM account, but in the user's session: needs SeTcbPrivilege, which SYSTEM has.
            if (!SetTokenInformation(copy, TOKEN_SESSION_ID, ref session, 4)) return null;
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.lpDesktop = "winsta0\\default";
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe");
            StringBuilder command = new StringBuilder("\"" + powershell + "\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + scriptPath + "\" -Mode session");
            PROCESS_INFORMATION info;
            if (!CreateProcessAsUser(copy, null, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out info)) return null;
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            return Process.GetProcessById(info.dwProcessId);
        }
        finally
        {
            if (copy != IntPtr.Zero) CloseHandle(copy);
            CloseHandle(token);
        }
    }

    // ── session mode ────────────────────────────────────────────────────────

    public static void RunSession()
    {
        // Physical pixels on every monitor.
        try
        {
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
        }
        catch (Exception)
        {
            try { SetProcessDPIAware(); } catch (Exception) { }
        }
        for (;;)
        {
            NamedPipeServerStream pipe = null;
            try
            {
                pipe = CreatePipe();
                pipe.WaitForConnection();
                NamedPipeServerStream connected = pipe;
                // A fresh thread has no windows, so SetThreadDesktop works on it.
                Thread worker = new Thread(delegate () { Serve(connected); });
                worker.IsBackground = true;
                worker.Start();
            }
            catch (Exception)
            {
                if (pipe != null) pipe.Dispose();
                Thread.Sleep(1000);
            }
        }
    }

    static NamedPipeServerStream CreatePipe()
    {
        PipeSecurity security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        // The signed-in (interactive) user's apps may talk to it; no one may create another instance.
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return new NamedPipeServerStream(PipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte, PipeOptions.None, 1 << 16, 1 << 22, security);
    }

    [ThreadStatic] static IntPtr attachedDesktop;

    static void Serve(NamedPipeServerStream pipe)
    {
        try
        {
            StreamReader reader = new StreamReader(pipe, Encoding.ASCII);
            StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false));
            writer.NewLine = "\n";
            writer.AutoFlush = true;
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                string reply;
                try { reply = Handle(line); }
                catch (Exception) { reply = line.StartsWith("frame") ? "noframe" : null; }
                if (reply != null) writer.WriteLine(reply);
            }
        }
        catch (Exception) { }
        finally
        {
            try { ReleaseAll(); } catch (Exception) { }
            try { pipe.Dispose(); } catch (Exception) { }
        }
    }

    static string Handle(string line)
    {
        string[] p = line.Split(' ');
        switch (p[0])
        {
            case "ping": return "pong";
            case "status": return SessionLocked() ? "locked" : "unlocked";
            case "frame":
                if (!SessionLocked()) return "noframe";
                return Frame(Int(p, 1, 1600), Int(p, 2, 60));
        }
        // Everything below acts on the desktop: only while the session is locked.
        if (!SessionLocked()) return null;
        AttachInputDesktop();
        switch (p[0])
        {
            case "m": MoveTo(Num(p, 1), Num(p, 2)); break;
            case "d": Button(Int(p, 1, -1), Num(p, 2), Num(p, 3), true); break;
            case "u": Button(Int(p, 1, -1), Num(p, 2), Num(p, 3), false); break;
            case "w": Scroll(Int(p, 1, 0), Int(p, 2, 0)); break;
            case "k": Key(Int(p, 1, 0), p.Length > 2 && p[2] == "1"); break;
            case "t": if (p.Length > 1) Text(p[1]); break;
            case "sas": try { SendSAS(false); } catch (Exception) { } break;
            case "r": ReleaseAll(); break;
        }
        return null;
    }

    static int Int(string[] p, int index, int fallback)
    {
        int value;
        return p.Length > index && int.TryParse(p[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
    }

    static double Num(string[] p, int index)
    {
        double value;
        if (p.Length <= index || !double.TryParse(p[index], NumberStyles.Float, CultureInfo.InvariantCulture, out value)) return 0;
        return Math.Max(0, Math.Min(1, value));
    }

    // ── lock state ──

    static DateTime lockCheckedAt = DateTime.MinValue;
    static bool lockCached;

    /// True only while this session is locked (WTS_SESSIONSTATE_LOCK). Unknown = not locked.
    static bool SessionLocked()
    {
        if ((DateTime.UtcNow - lockCheckedAt).TotalMilliseconds < 300) return lockCached;
        bool locked = false;
        uint session;
        if (ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out session))
        {
            IntPtr buffer;
            int bytes;
            if (WTSQuerySessionInformation(IntPtr.Zero, session, WTS_SESSION_INFO_EX, out buffer, out bytes))
            {
                try
                {
                    // WTSINFOEXW: Level, then WTSINFOEX_LEVEL1_W { SessionId, SessionState, SessionFlags, ... }.
                    // The union is 8-byte aligned (it holds LARGE_INTEGERs), so it normally starts at 8;
                    // find it by the session ID instead of assuming the padding.
                    if (bytes >= 20 && Marshal.ReadInt32(buffer, 0) == 1)
                    {
                        int flagsAt = (uint)Marshal.ReadInt32(buffer, 8) == session ? 16 : (uint)Marshal.ReadInt32(buffer, 4) == session ? 12 : -1;
                        // WTS_SESSIONSTATE_LOCK = 0, WTS_SESSIONSTATE_UNLOCK = 1 (Windows 8+).
                        if (flagsAt > 0) locked = Marshal.ReadInt32(buffer, flagsAt) == 0;
                    }
                }
                finally { WTSFreeMemory(buffer); }
            }
        }
        lockCached = locked;
        lockCheckedAt = DateTime.UtcNow;
        return locked;
    }

    /// Follow whichever desktop has the keyboard now (the lock screen / sign-in desktop).
    static void AttachInputDesktop()
    {
        IntPtr desktop = OpenInputDesktop(0, false, GENERIC_ALL);
        if (desktop == IntPtr.Zero) return;
        if (SetThreadDesktop(desktop))
        {
            if (attachedDesktop != IntPtr.Zero) CloseDesktop(attachedDesktop);
            attachedDesktop = desktop;
        }
        else CloseDesktop(desktop);
    }

    // ── capture ──

    static string Frame(int maxWidth, int quality)
    {
        AttachInputDesktop();
        int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
        if (w <= 0 || h <= 0) return "noframe";
        using (Bitmap full = new Bitmap(w, h, PixelFormat.Format24bppRgb))
        {
            using (Graphics g = Graphics.FromImage(full))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            int outW = Math.Min(w, Math.Max(320, maxWidth));
            int outH = (int)Math.Round((double)h * outW / w);
            if (outW == w) return "frame " + w + " " + h + " " + Jpeg(full, quality);
            using (Bitmap scaled = new Bitmap(outW, outH, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(full, 0, 0, outW, outH);
                }
                return "frame " + outW + " " + outH + " " + Jpeg(scaled, quality);
            }
        }
    }

    static string Jpeg(Bitmap image, int quality)
    {
        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
        using (MemoryStream stream = new MemoryStream())
        {
            EncoderParameters parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(20, Math.Min(90, quality)));
            image.Save(stream, codec, parameters);
            return Convert.ToBase64String(stream.ToArray());
        }
    }

    // ── input ──

    static readonly HashSet<int> keysDown = new HashSet<int>();
    static readonly bool[] buttonsDown = new bool[3];
    static double lastX = 0.5, lastY = 0.5;
    static double wheelX, wheelY;

    static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

    static INPUT Mouse(uint flags, int dx, int dy, uint data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = dx;
        i.u.mi.dy = dy;
        i.u.mi.mouseData = data;
        i.u.mi.dwFlags = flags;
        return i;
    }

    static INPUT Absolute(double nx, double ny)
    {
        return Mouse(MOVE | ABSOLUTE | VIRTUALDESK, (int)Math.Round(nx * 65535), (int)Math.Round(ny * 65535), 0);
    }

    static void MoveTo(double nx, double ny)
    {
        lastX = nx;
        lastY = ny;
        Send(new INPUT[] { Absolute(nx, ny) });
    }

    static void Button(int b, double nx, double ny, bool down)
    {
        if (b < 0 || b > 2) return;
        uint flag = b == 0 ? (down ? LEFTDOWN : LEFTUP) : b == 2 ? (down ? RIGHTDOWN : RIGHTUP) : (down ? MIDDLEDOWN : MIDDLEUP);
        buttonsDown[b] = down;
        lastX = nx;
        lastY = ny;
        Send(new INPUT[] { Absolute(nx, ny), Mouse(flag, 0, 0, 0) });
    }

    static void Scroll(int dx, int dy)
    {
        wheelY += -dy * 1.2;
        wheelX += dx * 1.2;
        int y = (int)wheelY, x = (int)wheelX;
        wheelY -= y;
        wheelX -= x;
        List<INPUT> list = new List<INPUT>();
        if (y != 0) list.Add(Mouse(WHEEL, 0, 0, unchecked((uint)y)));
        if (x != 0) list.Add(Mouse(HWHEEL, 0, 0, unchecked((uint)x)));
        if (list.Count > 0) Send(list.ToArray());
    }

    static void Key(int scanCode, bool down)
    {
        if (scanCode <= 0 || scanCode > 0xE0FF) return;
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wScan = (ushort)(scanCode & 0xFF);
        i.u.ki.dwFlags = KEY_SCANCODE | ((scanCode & 0xE000) == 0xE000 ? KEY_EXTENDED : 0) | (down ? 0 : KEY_UP);
        if (down) keysDown.Add(scanCode); else keysDown.Remove(scanCode);
        Send(new INPUT[] { i });
    }

    static void Text(string hex)
    {
        List<INPUT> list = new List<INPUT>();
        for (int at = 0; at + 4 <= hex.Length && at < 1024; at += 4)
        {
            ushort unit = Convert.ToUInt16(hex.Substring(at, 4), 16);
            for (int pass = 0; pass < 2; pass++)
            {
                INPUT i = new INPUT();
                i.type = INPUT_KEYBOARD;
                i.u.ki.wScan = unit;
                i.u.ki.dwFlags = KEY_UNICODE | (pass == 1 ? KEY_UP : 0);
                list.Add(i);
            }
        }
        if (list.Count > 0) Send(list.ToArray());
    }

    static void ReleaseAll()
    {
        for (int b = 0; b < 3; b++) if (buttonsDown[b]) Button(b, lastX, lastY, false);
        foreach (int key in new List<int>(keysDown)) Key(key, false);
    }
}
