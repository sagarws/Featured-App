# remote-input: keyboard and mouse injection for Remote Desktop (Windows).
#
# Long-running helper started by the app's main process; one command per line
# on stdin, same protocol as native/mac/remote-input.c:
#
#   m X Y          move to X,Y (physical pixels, virtual-desktop coordinates)
#   d B X Y C      button B down (0 left, 1 middle, 2 right); C = click count (Windows counts itself)
#   u B X Y C      button B up
#   w DX DY        scroll by DX,DY pixels (browser sign: +DY = down)
#   k SC 1|0       key by set-1 scan code (0xE0xx = extended), down / up
#   t HEX          type text: UTF-16 code units, 4 hex digits each
#   r              release every key and button still held
#   a              print "trusted" (no permission needed on Windows)
#   p              print "pong"
#
# Uses SendInput with scan codes, so the host's keyboard layout applies and
# shortcuts work. Windows does not let a normal process inject into elevated
# (administrator) windows, the secure desktop (UAC prompts, Ctrl+Alt+Del, the
# lock screen) — see docs/REMOTE_DESKTOP.md.

$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class RemoteInput {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public UNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x1, LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, MIDDLEDOWN = 0x20, MIDDLEUP = 0x40;
  const uint WHEEL = 0x800, HWHEEL = 0x1000, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
  const uint KEY_EXTENDED = 0x1, KEY_UP = 0x2, KEY_UNICODE = 0x4, KEY_SCANCODE = 0x8;

  static readonly HashSet<int> keysDown = new HashSet<int>();
  static readonly bool[] buttonsDown = new bool[3];
  static int lastX, lastY;
  static double wheelX, wheelY;

  static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT(); i.type = INPUT_MOUSE;
    i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
    return i;
  }

  static INPUT Absolute(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    return Mouse(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny, 0);
  }

  static void Move(int x, int y) { lastX = x; lastY = y; Send(new[] { Absolute(x, y) }); }

  static void Button(int b, int x, int y, bool down) {
    if (b < 0 || b > 2) return;
    uint flag = b == 0 ? (down ? LEFTDOWN : LEFTUP) : b == 2 ? (down ? RIGHTDOWN : RIGHTUP) : (down ? MIDDLEDOWN : MIDDLEUP);
    buttonsDown[b] = down; lastX = x; lastY = y;
    Send(new[] { Absolute(x, y), Mouse(flag, 0, 0, 0) });
  }

  static void Scroll(int dx, int dy) {
    // Browsers report ~100 px per wheel notch; Windows counts 120 per notch and accepts fractions of it.
    wheelY += -dy * 1.2; wheelX += dx * 1.2;
    int y = (int)wheelY, x = (int)wheelX;
    wheelY -= y; wheelX -= x;
    var list = new List<INPUT>();
    if (y != 0) list.Add(Mouse(WHEEL, 0, 0, unchecked((uint)y)));
    if (x != 0) list.Add(Mouse(HWHEEL, 0, 0, unchecked((uint)x)));
    if (list.Count > 0) Send(list.ToArray());
  }

  static void Key(int sc, bool down) {
    if (sc <= 0 || sc > 0xE0FF) return;
    INPUT i = new INPUT(); i.type = INPUT_KEYBOARD;
    i.u.ki.wScan = (ushort)(sc & 0xFF);
    i.u.ki.dwFlags = KEY_SCANCODE | ((sc & 0xE000) == 0xE000 ? KEY_EXTENDED : 0) | (down ? 0 : KEY_UP);
    if (down) keysDown.Add(sc); else keysDown.Remove(sc);
    Send(new[] { i });
  }

  static void Text(string hex) {
    var list = new List<INPUT>();
    for (int at = 0; at + 4 <= hex.Length && at < 1024; at += 4) {
      ushort unit = Convert.ToUInt16(hex.Substring(at, 4), 16);
      foreach (bool up in new[] { false, true }) {
        INPUT i = new INPUT(); i.type = INPUT_KEYBOARD;
        i.u.ki.wScan = unit; i.u.ki.dwFlags = KEY_UNICODE | (up ? KEY_UP : 0);
        list.Add(i);
      }
    }
    if (list.Count > 0) Send(list.ToArray());
  }

  static void ReleaseAll() {
    for (int b = 0; b < 3; b++) if (buttonsDown[b]) Button(b, lastX, lastY, false);
    foreach (int sc in new List<int>(keysDown)) Key(sc, false);
  }

  public static void Run() {
    // Physical pixels on every monitor, whatever its scaling.
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      try {
        string[] p = line.Split(' ');
        switch (p[0]) {
          case "m": Move((int)double.Parse(p[1], System.Globalization.CultureInfo.InvariantCulture), (int)double.Parse(p[2], System.Globalization.CultureInfo.InvariantCulture)); break;
          case "d": case "u":
            Button(int.Parse(p[1]), (int)double.Parse(p[2], System.Globalization.CultureInfo.InvariantCulture), (int)double.Parse(p[3], System.Globalization.CultureInfo.InvariantCulture), p[0] == "d"); break;
          case "w": Scroll(int.Parse(p[1]), int.Parse(p[2])); break;
          case "k": Key(int.Parse(p[1]), p[2] == "1"); break;
          case "t": if (p.Length > 1) Text(p[1]); break;
          case "r": ReleaseAll(); break;
          case "a": Console.Out.WriteLine("trusted"); Console.Out.Flush(); break;
          case "p": Console.Out.WriteLine("pong"); Console.Out.Flush(); break;
        }
      } catch (Exception) { }
    }
    ReleaseAll();
  }
}
'@

[RemoteInput]::Run()
