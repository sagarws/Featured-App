/*
 * remote-capture: a JPEG of the main display, for Remote Desktop while this
 * Mac is LOCKED (part of remote-input.node; see remote-input.c).
 *
 * The app's normal video comes from Chromium's screen capture, which macOS
 * stops at the lock screen. These system calls still return the lock screen
 * to an app that has Screen Recording, so the viewer sees it and can type the
 * password (input goes through the same in-process CoreGraphics events).
 *
 *   macOS 15.2+   SCScreenshotManager captureImageInRect
 *   older         CGDisplayCreateImage (looked up at run time: the current SDK
 *                 marks it unavailable, older systems still have it)
 *
 * Called on a worker thread (napi async work), never the app's main thread.
 */
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

typedef CGImageRef (*DisplayCreateImageFn)(CGDirectDisplayID);

static CGImageRef captureMain(void) {
  CGDirectDisplayID display = CGMainDisplayID();
  if (@available(macOS 15.2, *)) {
    __block CGImageRef image = NULL;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [SCScreenshotManager captureImageInRect:CGDisplayBounds(display)
                          completionHandler:^(CGImageRef result, NSError *error) {
                            if (result) image = CGImageRetain(result);
                            dispatch_semaphore_signal(done);
                          }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)) != 0) return NULL;
    if (image) return image;
  }
  DisplayCreateImageFn create = (DisplayCreateImageFn)dlsym(RTLD_DEFAULT, "CGDisplayCreateImage");
  return create ? create(display) : NULL;
}

/* The main display as JPEG, at most maxWidth wide. 0 on success; *jpeg is malloc'd (caller frees). */
int remoteCaptureJpeg(int maxWidth, int quality, unsigned char **jpeg, size_t *length, int *width, int *height) {
  @autoreleasepool {
    CGImageRef image = captureMain();
    if (!image) return 1;
    size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
    if (maxWidth > 0 && w > (size_t)maxWidth) {
      size_t sw = (size_t)maxWidth, sh = (size_t)((double)h * maxWidth / (double)w);
      CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
      CGContextRef ctx = CGBitmapContextCreate(NULL, sw, sh, 8, 0, space, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
      CGColorSpaceRelease(space);
      if (!ctx) {
        CGImageRelease(image);
        return 2;
      }
      CGContextSetInterpolationQuality(ctx, kCGInterpolationMedium);
      CGContextDrawImage(ctx, CGRectMake(0, 0, sw, sh), image);
      CGImageRelease(image);
      image = CGBitmapContextCreateImage(ctx);
      CGContextRelease(ctx);
      if (!image) return 2;
      w = sw;
      h = sh;
    }
    CFMutableDataRef data = CFDataCreateMutable(NULL, 0);
    CGImageDestinationRef dest = CGImageDestinationCreateWithData(data, CFSTR("public.jpeg"), 1, NULL);
    if (!dest) {
      CFRelease(data);
      CGImageRelease(image);
      return 3;
    }
    double q = quality < 1 ? 0.6 : quality > 100 ? 1.0 : quality / 100.0;
    NSDictionary *options = @{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality : @(q)};
    CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)options);
    bool ok = CGImageDestinationFinalize(dest);
    CFRelease(dest);
    CGImageRelease(image);
    if (!ok) {
      CFRelease(data);
      return 3;
    }
    *length = (size_t)CFDataGetLength(data);
    *jpeg = malloc(*length);
    if (!*jpeg) {
      CFRelease(data);
      return 4;
    }
    memcpy(*jpeg, CFDataGetBytePtr(data), *length);
    CFRelease(data);
    *width = (int)w;
    *height = (int)h;
    return 0;
  }
}
