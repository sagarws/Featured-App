/*
 * audio-permission: checks or requests the macOS "System Audio Recording"
 * permission (TCC service kTCCServiceAudioCapture), which has no public API.
 * Uses the TCC framework's preflight/request calls, as audio-tap apps do.
 * macOS attributes the request to the app that launched this helper, so the
 * prompt shows the app's name and its NSAudioCaptureUsageDescription.
 *
 *   audio-permission status   → prints granted | denied | not-determined | unknown
 *   audio-permission request  → asks if not decided yet, then prints the result
 *
 * Build: scripts/build-native-mac.cjs (clang, no Xcode project).
 */
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

typedef int (*PreflightFn)(CFStringRef service, CFDictionaryRef options);
typedef void (*RequestFn)(CFStringRef service, CFDictionaryRef options, void (^callback)(Boolean granted));

static const char *describe(int preflight) {
  switch (preflight) {
    case 0: return "granted";
    case 1: return "denied";
    case 2: return "not-determined";
    default: return "unknown";
  }
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "status";
  void *tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW);
  PreflightFn preflight = tcc ? (PreflightFn)dlsym(tcc, "TCCAccessPreflight") : NULL;
  RequestFn request = tcc ? (RequestFn)dlsym(tcc, "TCCAccessRequest") : NULL;
  if (!preflight) {
    puts("unknown");
    return 0;
  }
  CFStringRef service = CFSTR("kTCCServiceAudioCapture");
  int state = preflight(service, NULL);
  if (strcmp(mode, "request") == 0 && state != 0 && state != 1 && request) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block Boolean granted = false;
    request(service, NULL, ^(Boolean ok) {
      granted = ok;
      dispatch_semaphore_signal(done);
    });
    // The user may take a while to answer the prompt.
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 300LL * NSEC_PER_SEC)) != 0) {
      puts(describe(preflight(service, NULL)));
      return 0;
    }
    puts(granted ? "granted" : "denied");
    return 0;
  }
  puts(describe(state));
  return 0;
}
