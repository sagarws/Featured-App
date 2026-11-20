#!/usr/bin/env python3
"""remote-input: keyboard and mouse injection for Remote Desktop (Linux, X11).

Long-running helper started by the app's main process; one command per line on
stdin, same protocol as native/mac/remote-input.c:

  m X Y          move to X,Y (X11 screen pixels)
  d B X Y C      button B down (0 left, 1 middle, 2 right)
  u B X Y C      button B up
  w DX DY        scroll by DX,DY pixels (browser sign: +DY = down)
  k CODE 1|0     X11 keycode (evdev + 8) down / up
  t HEX          type text: UTF-16 code units, 4 hex digits each
  r              release every key and button still held
  a              print "trusted", or "untrusted <reason>" without an X11 display
  p              print "pong"

Uses the XTEST extension through ctypes (libX11 + libXtst, present on X11
desktops), with no Python packages. Wayland sessions do not allow this kind of
injection; see docs/REMOTE_DESKTOP.md.
"""
import ctypes
import ctypes.util
import sys
import time


def load(name, fallback):
    path = ctypes.util.find_library(name) or fallback
    return ctypes.cdll.LoadLibrary(path)


try:
    x11 = load('X11', 'libX11.so.6')
    xtst = load('Xtst', 'libXtst.so.6')
except OSError as error:
    x11 = None
    LOAD_ERROR = 'missing libX11/libXtst: %s' % error
else:
    LOAD_ERROR = None

display = None
if x11 is not None:
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XDisplayKeycodes.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
    x11.XGetKeyboardMapping.restype = ctypes.POINTER(ctypes.c_ulong)
    x11.XGetKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    x11.XChangeKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_ulong), ctypes.c_int]
    x11.XFree.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x11.XOpenDisplay(None)

keys_down = set()
buttons_down = set()
last = [0, 0]
wheel = [0.0, 0.0]
spare_keycode = None


def flush():
    x11.XFlush(display)


def move(x, y):
    last[0], last[1] = x, y
    xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
    flush()


def button(b, x, y, down):
    x_button = {0: 1, 1: 2, 2: 3}.get(b)
    if x_button is None:
        return
    move(x, y)
    xtst.XTestFakeButtonEvent(display, x_button, 1 if down else 0, 0)
    (buttons_down.add if down else buttons_down.discard)(b)
    flush()


def click(x_button, times):
    for _ in range(times):
        xtst.XTestFakeButtonEvent(display, x_button, 1, 0)
        xtst.XTestFakeButtonEvent(display, x_button, 0, 0)
    flush()


def scroll(dx, dy):
    # X11 scrolls in notches (buttons 4-7); about 100 browser pixels per notch.
    wheel[0] += dx / 100.0
    wheel[1] += dy / 100.0
    ny, nx = int(wheel[1]), int(wheel[0])
    wheel[1] -= ny
    wheel[0] -= nx
    if ny:
        click(5 if ny > 0 else 4, abs(ny))
    if nx:
        click(7 if nx > 0 else 6, abs(nx))


def key(code, down):
    if code < 8 or code > 255:
        return
    xtst.XTestFakeKeyEvent(display, code, 1 if down else 0, 0)
    (keys_down.add if down else keys_down.discard)(code)
    flush()


def find_spare_keycode():
    low, high = ctypes.c_int(), ctypes.c_int()
    x11.XDisplayKeycodes(display, ctypes.byref(low), ctypes.byref(high))
    per = ctypes.c_int()
    count = high.value - low.value + 1
    mapping = x11.XGetKeyboardMapping(display, low.value, count, ctypes.byref(per))
    try:
        for index in range(count - 1, -1, -1):
            if all(mapping[index * per.value + j] == 0 for j in range(per.value)):
                return low.value + index
    finally:
        x11.XFree(mapping)
    return None


def text(hex_units):
    global spare_keycode
    units = [int(hex_units[i:i + 4], 16) for i in range(0, min(len(hex_units), 1024), 4)]
    chars = bytes(b for u in units for b in u.to_bytes(2, 'little')).decode('utf-16-le', 'ignore')
    if spare_keycode is None:
        spare_keycode = find_spare_keycode()
    if spare_keycode is None:
        return
    for ch in chars:
        cp = ord(ch)
        keysym = cp if (0x20 <= cp <= 0x7e or 0xa0 <= cp <= 0xff) else 0x01000000 | cp
        syms = (ctypes.c_ulong * 2)(keysym, keysym)
        x11.XChangeKeyboardMapping(display, spare_keycode, 2, syms, 1)
        x11.XSync(display, 0)
        xtst.XTestFakeKeyEvent(display, spare_keycode, 1, 0)
        xtst.XTestFakeKeyEvent(display, spare_keycode, 0, 0)
        x11.XSync(display, 0)
        time.sleep(0.002)
    empty = (ctypes.c_ulong * 2)(0, 0)
    x11.XChangeKeyboardMapping(display, spare_keycode, 2, empty, 1)
    flush()


def release_all():
    for b in list(buttons_down):
        button(b, last[0], last[1], False)
    for code in list(keys_down):
        key(code, False)


def reply(line):
    sys.stdout.write(line + '\n')
    sys.stdout.flush()


def main():
    for raw in sys.stdin:
        parts = raw.split()
        if not parts:
            continue
        op = parts[0]
        if op == 'p':
            reply('pong')
            continue
        if op == 'a':
            reply('trusted' if display else 'untrusted %s' % (LOAD_ERROR or 'cannot open the X11 display (Wayland?)'))
            continue
        if not display:
            continue
        try:
            if op == 'm':
                move(int(float(parts[1])), int(float(parts[2])))
            elif op in ('d', 'u'):
                button(int(parts[1]), int(float(parts[2])), int(float(parts[3])), op == 'd')
            elif op == 'w':
                scroll(int(parts[1]), int(parts[2]))
            elif op == 'k':
                key(int(parts[1]), parts[2] == '1')
            elif op == 't' and len(parts) > 1:
                text(parts[1])
            elif op == 'r':
                release_all()
        except (ValueError, IndexError):
            pass
    if display:
        release_all()


if __name__ == '__main__':
    main()
