// ardia-frames - stream the Ardia window's pixels to ardia-pane, near instantly.
//
// ScreenCaptureKit captures the window (also when it's behind other windows) and only
// delivers a frame when its content changed; the GPU scales it to the pane's pixel size.
// Each new frame goes into a fresh POSIX shared-memory object as RGB, and its name is
// printed on stdout ("<name> <width> <height>"). The terminal opens and unlinks it
// (kitty graphics, t=s), so pixels never pass through the pty or tmux.
//
// Build: swiftc -O -import-objc-header ardia-frames-shim.h -o ../bin/ardia-frames ardia-frames.swift
// Usage: ardia-frames <width> <height> [x y w h] [--window ID]   crop rect in window points
//        ardia-frames --list                             Ardia's windows: "<id> <width>x<height> <title>"
// stdin: "size W H" / "crop X Y W H" lines update the stream; EOF quits.
//        "png PATH W H" decodes that PNG (a CDP screenshot), deletes it, scales it to W x H and
//        hands it over the same way, printed as "png <name> <width> <height>" ("png -" if unreadable).
// stdout: "ready" once capture runs and commands are read, then frames as above.
// Needs Screen Recording for the app that runs it (the terminal).

import Accelerate
import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)
_ = NSApplication.shared  // ScreenCaptureKit needs a WindowServer connection
func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

var rawArgs = Array(CommandLine.arguments.dropFirst())
let listOnly = rawArgs.first == "--list"
var windowID: UInt32? = nil
if let i = rawArgs.firstIndex(of: "--window"), i + 1 < rawArgs.count {
  windowID = UInt32(rawArgs[i + 1]); rawArgs.removeSubrange(i...(i + 1))
}
let argv = rawArgs.compactMap { Double($0) }
guard listOnly || argv.count == 2 || argv.count == 6 else { fail("usage: ardia-frames <width> <height> [x y w h] [--window ID] | --list") }

final class Frames: NSObject, SCStreamOutput, SCStreamDelegate {
  var seq = 0
  var recent: [String] = []  // names handed out; unlinked if the terminal never read them

  func stream(_ stream: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
      let info = (CMSampleBufferGetSampleAttachmentsArray(buf, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
      let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
      let px = CMSampleBufferGetImageBuffer(buf)
    else { return }
    CVPixelBufferLockBaseAddress(px, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }
    var src = vImage_Buffer(data: CVPixelBufferGetBaseAddress(px), height: vImagePixelCount(CVPixelBufferGetHeight(px)),
                            width: vImagePixelCount(CVPixelBufferGetWidth(px)), rowBytes: CVPixelBufferGetBytesPerRow(px))
    if let name = publish(&src, vImageConvert_BGRA8888toRGB888) { print("\(name) \(src.width) \(src.height)") }
  }

  // A screenshot PNG -> W x H RGB in shared memory, so the terminal gets a pane-sized frame
  // instead of decoding and uploading a full-size PNG for every screenshot.
  func png(_ path: String, _ w: Int, _ h: Int) {
    let data = FileManager.default.contents(atPath: path)
    unlink(path)
    guard w > 0, h > 0, let data,
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { print("png -"); return }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    var src = vImage_Buffer(data: ctx.data, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: ctx.bytesPerRow)
    if let name = publish(&src, vImageConvert_RGBA8888toRGB888) { print("png \(name) \(w) \(h)") } else { print("png -") }
  }

  // Converts a 4-byte-per-pixel image (with row padding) to tightly packed RGB (a quarter less for
  // the terminal to copy), straight into a fresh shared-memory object; returns its name.
  func publish(_ src: inout vImage_Buffer,
               _ convert: (UnsafePointer<vImage_Buffer>, UnsafePointer<vImage_Buffer>, vImage_Flags) -> vImage_Error) -> String? {
    let w = Int(src.width), h = Int(src.height)
    let size = w * h * 3
    seq += 1
    let name = "/ardia-pane-\(getpid())-\(seq)"
    let fd = shm_create(name)
    guard fd >= 0, ftruncate(fd, off_t(size)) == 0,
      let mem = mmap(nil, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0), mem != MAP_FAILED
    else { if fd >= 0 { close(fd); shm_unlink(name) }; return nil }
    var dst = vImage_Buffer(data: mem, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 3)
    _ = convert(&src, &dst, vImage_Flags(kvImageNoFlags))
    munmap(mem, size)
    close(fd)
    recent.append(name)
    if recent.count > 8 { shm_unlink(recent.removeFirst()) }  // unread frames don't pile up
    return name
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) { fail("capture stopped: \(error.localizedDescription)") }

  func cleanup() { recent.forEach { shm_unlink($0) } }
}

let frames = Frames()
let config = SCStreamConfiguration()
if !listOnly { config.width = Int(argv[0]); config.height = Int(argv[1]) }
if argv.count == 6 { config.sourceRect = CGRect(x: argv[2], y: argv[3], width: argv[4], height: argv[5]) }
config.pixelFormat = kCVPixelFormatType_32BGRA
config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
config.showsCursor = false
config.queueDepth = 3

Task {
  let content: SCShareableContent
  do { content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) } catch {
    fail("Screen Recording permission is needed (System Settings > Privacy & Security > Screen Recording): \(error.localizedDescription)")
  }
  let windows = content.windows.filter {
    $0.owningApplication?.bundleIdentifier == "com.ardia.browser" && $0.windowLayer == 0 && $0.frame.width > 300 && $0.frame.height > 200
  }
  if listOnly {
    for w in windows { print("\(w.windowID) \(Int(w.frame.width))x\(Int(w.frame.height)) \(w.title ?? "")") }
    exit(0)
  }
  // The asked-for window, else the front-most normal one (content.windows is front to back).
  let picked = windowID.map { id in windows.first { $0.windowID == id } } ?? (windows.first { $0.isOnScreen } ?? windows.first)
  guard let win = picked else { fail(windowID.map { "no Ardia window \($0)" } ?? "no Ardia window") }
  FileHandle.standardError.write("window \(Int(win.frame.width))x\(Int(win.frame.height))\n".data(using: .utf8)!)
  let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: win), configuration: config, delegate: frames)
  let queue = DispatchQueue(label: "frames", qos: .userInteractive)
  do {
    try stream.addStreamOutput(frames, type: .screen, sampleHandlerQueue: queue)
    try await stream.startCapture()
  } catch { fail("capture failed: \(error.localizedDescription)") }

  // Commands from ardia-pane: size / crop changes and screenshots; EOF means the pane closed.
  print("ready")
  Thread.detachNewThread {
    while let line = readLine() {
      let p = line.split(separator: " ")
      let n = p.dropFirst().compactMap { Double($0) }
      if p.first == "png", p.count == 4, let w = Int(p[2]), let h = Int(p[3]) {
        let path = String(p[1])
        queue.async { frames.png(path, w, h) }
        continue
      }
      if p.first == "size", n.count == 2 { config.width = Int(n[0]); config.height = Int(n[1]) }
      else if p.first == "crop", n.count == 4 { config.sourceRect = CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) }
      else { continue }
      stream.updateConfiguration(config) { _ in }
    }
    queue.sync { frames.cleanup() }
    exit(0)
  }
}
signal(SIGPIPE, SIG_IGN)
for sig in [SIGINT, SIGTERM, SIGHUP] { signal(sig) { _ in exit(0) } }
RunLoop.main.run()
