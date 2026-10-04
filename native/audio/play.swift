import Foundation
import AudioToolbox
import CoreAudio

func check(_ status: OSStatus, _ operation: String) throws {
    if status != noErr { throw NSError(domain: operation, code: Int(status)) }
}
func property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    try withUnsafeMutablePointer(to: &value) { pointer in
        try check(AudioObjectGetPropertyData(id, &address, 0, nil, &size, pointer), "device_property")
    }
    return value as String
}
func devices() throws -> [(String, String)] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size), "device_list_size")
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids), "device_list")
    return try ids.map { (try property($0, kAudioObjectPropertyName), try property($0, kAudioDevicePropertyDeviceUID)) }
}
final class Playback {
    let done = DispatchSemaphore(value: 0)
}
do {
    let args = CommandLine.arguments
    if args.count == 2 && args[1] == "--list" {
        for (name, uid) in try devices() { print("\(name)\t\(uid)") }
        exit(0)
    }
    guard args.count == 3 else { throw NSError(domain: "usage: play <device-name> <pcm-wav>", code: 1) }
    let matching = try devices().filter { $0.0 == args[1] }
    guard matching.count == 1 else { throw NSError(domain: "device_missing_or_ambiguous", code: 1) }
    var file: AudioFileID?
    try check(AudioFileOpenURL(URL(fileURLWithPath: args[2]) as CFURL, .readPermission, 0, &file), "open_audio")
    guard let file else { throw NSError(domain: "audio_missing", code: 1) }
    defer { AudioFileClose(file) }
    var format = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(AudioFileGetProperty(file, kAudioFilePropertyDataFormat, &size, &format), "audio_format")
    guard format.mFormatID == kAudioFormatLinearPCM && format.mChannelsPerFrame <= 2 && format.mBytesPerFrame > 0 else { throw NSError(domain: "pcm_required", code: 1) }
    var bytes: UInt64 = 0
    size = UInt32(MemoryLayout<UInt64>.size)
    try check(AudioFileGetProperty(file, kAudioFilePropertyAudioDataByteCount, &size, &bytes), "audio_size")
    let duration = Double(bytes) / Double(format.mBytesPerFrame) / format.mSampleRate
    guard bytes > 0 && bytes < 12_000_000 && duration <= 30 else { throw NSError(domain: "audio_too_long_or_empty", code: 1) }
    let playback = Playback()
    var queue: AudioQueueRef?
    try check(AudioQueueNewOutput(&format, { context, _, _ in
        guard let context else { return }
        Unmanaged<Playback>.fromOpaque(context).takeUnretainedValue().done.signal()
    }, Unmanaged.passUnretained(playback).toOpaque(), nil, nil, 0, &queue), "queue_create")
    guard let queue else { throw NSError(domain: "queue_missing", code: 1) }
    defer { AudioQueueDispose(queue, true) }
    var uid = matching[0].1 as CFString
    try withUnsafePointer(to: &uid) { pointer in
        try check(AudioQueueSetProperty(queue, kAudioQueueProperty_CurrentDevice, pointer, UInt32(MemoryLayout<CFString>.size)), "queue_device")
    }
    var buffer: AudioQueueBufferRef?
    try check(AudioQueueAllocateBuffer(queue, UInt32(bytes), &buffer), "buffer_allocate")
    guard let buffer else { throw NSError(domain: "buffer_missing", code: 1) }
    var count = UInt32(bytes)
    try check(AudioFileReadBytes(file, false, 0, &count, buffer.pointee.mAudioData), "audio_read")
    buffer.pointee.mAudioDataByteSize = count
    try check(AudioQueueEnqueueBuffer(queue, buffer, 0, nil), "buffer_enqueue")
    try check(AudioQueueStart(queue, nil), "queue_start")
    guard playback.done.wait(timeout: .now() + duration + 5) == .success else { throw NSError(domain: "playback_timeout", code: 1) }
    try check(AudioQueueStop(queue, false), "queue_stop")
    print("playback_completed")
} catch {
    fputs("audio_error: \((error as NSError).domain) [\((error as NSError).code)]\n", stderr)
    exit(1)
}
