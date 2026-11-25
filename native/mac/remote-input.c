/*
 * remote-input: keyboard and mouse injection for Remote Desktop (macOS).
 *
 * A long-running helper: the app writes one command per line on stdin, the
 * helper posts the matching CoreGraphics event. It only ever acts on what
 * the app's main process sends it, and the main process only sends input for
 * an authorised full-control session (electron/main/remote/input).
 *
 * Needs the Accessibility permission (System Settings → Privacy & Security →
 * Accessibility; "Device Control and Data Access" on macOS 27+).
 *
 * Built two ways from this one file (scripts/build-native-mac.cjs):
 *   remote-input.node  a Node-API module loaded INTO the app's main process
 *                      (REMOTE_INPUT_ADDON). The app itself posts the events,
 *                      so macOS asks for the permission once, for "Featured
 *                      App" — not a second time for a separate helper.
 *   remote-input       the same commands over stdin/stdout, a standalone
 *                      helper: the fallback if the module cannot load.
 *
 *   m X Y            move to X,Y (global points, top-left of the main display)
 *   d B X Y C        button B down at X,Y; C = click count (2 = double click)
 *   u B X Y C        button B up
 *                    B: 0 left, 1 middle, 2 right
 *   w DX DY          scroll by DX,DY pixels (browser sign: +DY = down)
 *   k CODE 1|0       virtual key CODE down / up
 *   t HEX            type text: UTF-16 code units, 4 hex digits each
 *   r                release every key and button still held
 *   a                print "trusted" / "untrusted" (Accessibility)
 *   p                print "pong"
 *
 * Build: scripts/build-native-mac.cjs.
 */
#include <ApplicationServices/ApplicationServices.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static CGEventSourceRef source;
static int keyDown[128];
static int buttonDown[3];
static CGPoint cursor;

static CGEventFlags modifierFlag(int code) {
  switch (code) {
    case 55: case 54: return kCGEventFlagMaskCommand;
    case 56: case 60: return kCGEventFlagMaskShift;
    case 58: case 61: return kCGEventFlagMaskAlternate;
    case 59: case 62: return kCGEventFlagMaskControl;
    case 63: return kCGEventFlagMaskSecondaryFn;
    default: return 0;
  }
}

static int isNavigationKey(int code) {
  /* Arrows, Home/End, Page Up/Down, Forward Delete, Help: macOS marks these with Fn (+ numeric pad for arrows). */
  return (code >= 123 && code <= 126) || code == 115 || code == 119 || code == 116 || code == 121 || code == 117 || code == 114;
}

static CGEventFlags currentFlags(void) {
  CGEventFlags flags = 0;
  for (int i = 0; i < 128; i++) if (keyDown[i]) flags |= modifierFlag(i);
  if (CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & kCGEventFlagMaskAlphaShift) flags |= kCGEventFlagMaskAlphaShift;
  return flags;
}

static void post(CGEventRef event) {
  if (!event) return;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

static CGMouseButton cgButton(int b) {
  return b == 0 ? kCGMouseButtonLeft : b == 2 ? kCGMouseButtonRight : kCGMouseButtonCenter;
}

static void mouseMove(double x, double y) {
  cursor = CGPointMake(x, y);
  CGEventType type = kCGEventMouseMoved;
  CGMouseButton button = kCGMouseButtonLeft;
  if (buttonDown[0]) type = kCGEventLeftMouseDragged;
  else if (buttonDown[2]) { type = kCGEventRightMouseDragged; button = kCGMouseButtonRight; }
  else if (buttonDown[1]) { type = kCGEventOtherMouseDragged; button = kCGMouseButtonCenter; }
  CGEventRef e = CGEventCreateMouseEvent(source, type, cursor, button);
  CGEventSetFlags(e, currentFlags());
  post(e);
}

static void mouseButton(int b, double x, double y, int clicks, int down) {
  if (b < 0 || b > 2) return;
  cursor = CGPointMake(x, y);
  CGEventType type;
  if (b == 0) type = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
  else if (b == 2) type = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
  else type = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
  CGEventRef e = CGEventCreateMouseEvent(source, type, cursor, cgButton(b));
  CGEventSetIntegerValueField(e, kCGMouseEventClickState, clicks < 1 ? 1 : clicks);
  CGEventSetFlags(e, currentFlags());
  buttonDown[b] = down;
  post(e);
}

static void scroll(int dx, int dy) {
  CGEventRef e = CGEventCreateScrollWheelEvent(source, kCGScrollEventUnitPixel, 2, -dy, -dx);
  CGEventSetFlags(e, currentFlags());
  post(e);
}

static void key(int code, int down) {
  if (code < 0 || code > 127) return;
  CGEventRef e = CGEventCreateKeyboardEvent(source, (CGKeyCode)code, down ? true : false);
  if (!e) return;
  CGEventFlags flag = modifierFlag(code);
  keyDown[code] = down;
  CGEventFlags flags = currentFlags();
  if (flag) {
    CGEventSetType(e, kCGEventFlagsChanged);
  } else if (isNavigationKey(code)) {
    flags |= kCGEventFlagMaskSecondaryFn;
    if (code >= 123 && code <= 126) flags |= kCGEventFlagMaskNumericPad;
  }
  CGEventSetFlags(e, flags);
  post(e);
}

static void injectText(const char *hex) {
  size_t len = strlen(hex) / 4;
  if (len == 0 || len > 256) return;
  UniChar chars[256];
  for (size_t i = 0; i < len; i++) {
    char part[5] = { hex[i * 4], hex[i * 4 + 1], hex[i * 4 + 2], hex[i * 4 + 3], 0 };
    chars[i] = (UniChar)strtoul(part, NULL, 16);
  }
  /* macOS accepts at most 20 characters per event. */
  for (size_t at = 0; at < len; at += 20) {
    size_t n = len - at < 20 ? len - at : 20;
    CGEventRef down = CGEventCreateKeyboardEvent(source, 0, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, 0, false);
    CGEventSetFlags(down, 0);
    CGEventSetFlags(up, 0);
    CGEventKeyboardSetUnicodeString(down, n, chars + at);
    CGEventKeyboardSetUnicodeString(up, n, chars + at);
    post(down);
    post(up);
  }
}

static void releaseAll(void) {
  for (int b = 0; b < 3; b++) if (buttonDown[b]) mouseButton(b, cursor.x, cursor.y, 1, 0);
  for (int k = 0; k < 128; k++) if (keyDown[k]) key(k, 0);
}

static void setup(void) {
  source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  /* Our own events must not be merged with a local user's, nor suppress local input. */
  CGEventSourceSetLocalEventsSuppressionInterval(source, 0.0);
  CGEventRef now = CGEventCreate(NULL);
  cursor = CGEventGetLocation(now);
  CFRelease(now);
}

/* One command; the answer for the ones that have one ("a", "p"), else NULL. */
static const char *handle(const char *line) {
  double x, y;
  int b, c, code, down, dx, dy;
  char hex[1100];
  switch (line[0]) {
    case 'm': if (sscanf(line + 1, "%lf %lf", &x, &y) == 2) mouseMove(x, y); break;
    case 'd': if (sscanf(line + 1, "%d %lf %lf %d", &b, &x, &y, &c) == 4) mouseButton(b, x, y, c, 1); break;
    case 'u': if (sscanf(line + 1, "%d %lf %lf %d", &b, &x, &y, &c) == 4) mouseButton(b, x, y, c, 0); break;
    case 'w': if (sscanf(line + 1, "%d %d", &dx, &dy) == 2) scroll(dx, dy); break;
    case 'k': if (sscanf(line + 1, "%d %d", &code, &down) == 2) key(code, down); break;
    case 't': if (sscanf(line + 1, "%1024s", hex) == 1) injectText(hex); break;
    case 'r': releaseAll(); break;
    case 'a': return AXIsProcessTrusted() ? "trusted" : "untrusted";
    case 'p': return "pong";
    default: break;
  }
  return NULL;
}

#ifdef REMOTE_INPUT_ADDON
#define NAPI_VERSION 8
#include <node_api.h>

/* handle(line: string): string | null — the same commands as the helper's stdin. */
static napi_value JsHandle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;
  char line[2048];
  size_t length = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], line, sizeof line, &length) != napi_ok) {
    napi_get_null(env, &result);
    return result;
  }
  const char *answer = handle(line);
  if (answer) napi_create_string_utf8(env, answer, NAPI_AUTO_LENGTH, &result);
  else napi_get_null(env, &result);
  return result;
}

/* Promptless check / the system prompt, for the one-time setup. */
static napi_value JsTrusted(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  bool prompt = false;
  napi_value result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc >= 1) napi_get_value_bool(env, argv[0], &prompt);
  const void *keys[] = {kAXTrustedCheckOptionPrompt};
  const void *values[] = {prompt ? kCFBooleanTrue : kCFBooleanFalse};
  CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  bool trusted = AXIsProcessTrustedWithOptions(options);
  CFRelease(options);
  napi_get_boolean(env, trusted, &result);
  return result;
}

/* ── lock screen picture (remote-capture.m), off the main thread ── */
int remoteCaptureJpeg(int maxWidth, int quality, unsigned char **jpeg, size_t *length, int *width, int *height);

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  int maxWidth, quality, width, height, status;
  unsigned char *jpeg;
  size_t length;
} CaptureJob;

static void captureExecute(napi_env env, void *data) {
  CaptureJob *job = data;
  job->status = remoteCaptureJpeg(job->maxWidth, job->quality, &job->jpeg, &job->length, &job->width, &job->height);
}

static void captureComplete(napi_env env, napi_status status, void *data) {
  CaptureJob *job = data;
  napi_value result;
  if (status == napi_ok && job->status == 0 && job->jpeg) {
    napi_value buffer, value;
    void *bytes = NULL;
    napi_create_object(env, &result);
    napi_create_buffer_copy(env, job->length, job->jpeg, &bytes, &buffer);
    napi_set_named_property(env, result, "jpeg", buffer);
    napi_create_int32(env, job->width, &value);
    napi_set_named_property(env, result, "width", value);
    napi_create_int32(env, job->height, &value);
    napi_set_named_property(env, result, "height", value);
  } else {
    napi_get_null(env, &result);
  }
  napi_resolve_deferred(env, job->deferred, result);
  napi_delete_async_work(env, job->work);
  free(job->jpeg);
  free(job);
}

/* captureJpeg(maxWidth, quality): Promise<{ jpeg, width, height } | null> — the main display. */
static napi_value JsCaptureJpeg(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], promise, name;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  CaptureJob *job = calloc(1, sizeof *job);
  job->maxWidth = 1600;
  job->quality = 60;
  if (argc >= 1) napi_get_value_int32(env, argv[0], &job->maxWidth);
  if (argc >= 2) napi_get_value_int32(env, argv[1], &job->quality);
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "remoteCapture", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, captureExecute, captureComplete, job, &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

/* Screen Recording: ask (shows the system prompt once; true = already allowed). */
static napi_value JsRequestScreen(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, CGRequestScreenCaptureAccess(), &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  setup();
  napi_value fn;
  napi_create_function(env, "handle", NAPI_AUTO_LENGTH, JsHandle, NULL, &fn);
  napi_set_named_property(env, exports, "handle", fn);
  napi_create_function(env, "trusted", NAPI_AUTO_LENGTH, JsTrusted, NULL, &fn);
  napi_set_named_property(env, exports, "trusted", fn);
  napi_create_function(env, "requestScreen", NAPI_AUTO_LENGTH, JsRequestScreen, NULL, &fn);
  napi_set_named_property(env, exports, "requestScreen", fn);
  napi_create_function(env, "captureJpeg", NAPI_AUTO_LENGTH, JsCaptureJpeg, NULL, &fn);
  napi_set_named_property(env, exports, "captureJpeg", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#else
int main(void) {
  signal(SIGPIPE, SIG_IGN);
  setup();
  char line[2048];
  while (fgets(line, sizeof line, stdin)) {
    const char *answer = handle(line);
    if (answer) {
      puts(answer);
      fflush(stdout);
    }
  }
  releaseAll();
  return 0;
}
#endif
