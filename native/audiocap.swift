// sysaudio: streams system audio (everything the Mac plays) as 16 kHz mono PCM16 on stdout.
// Uses ScreenCaptureKit, so it needs only the Screen Recording permission. Status lines go to stderr.
import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation

final class Out: NSObject, SCStreamOutput, SCStreamDelegate {
    let stdout = FileHandle.standardOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        try? sb.withAudioBufferList { abl, _ in
            guard let fmt = sb.formatDescription?.audioStreamBasicDescription else { return }
            let frames = Int(sb.numSamples)
            let chans = abl.count
            guard frames > 0, chans > 0 else { return }
            var pcm = [Int16](repeating: 0, count: frames)
            let interleaved = (fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
            let perBuf = interleaved ? Int(fmt.mChannelsPerFrame) : 1
            for i in 0..<frames {
                var sum: Float = 0
                var n: Float = 0
                for b in abl {
                    guard let p = b.mData?.assumingMemoryBound(to: Float.self) else { continue }
                    for c in 0..<perBuf { sum += p[i * perBuf + c]; n += 1 }
                }
                let v = max(-1, min(1, n > 0 ? sum / n : 0))
                pcm[i] = Int16(v * 32767)
            }
            pcm.withUnsafeBufferPointer { stdout.write(Data(buffer: $0)) }
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write("stopped: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(2)
    }
}

// Mic mode: microphone with Apple's voice processing, which removes echo of whatever the Mac is playing.
func runMic(aec: Bool) {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    do {
        if aec {
            try input.setVoiceProcessingEnabled(true)
            input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        let inFmt = input.outputFormat(forBus: 0)
        // Voice processing exposes several channels; channel 0 carries the processed voice.
        let monoFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inFmt.sampleRate, channels: 1, interleaved: false)!
        let outFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
        guard let conv = AVAudioConverter(from: monoFmt, to: outFmt) else { throw NSError(domain: "mic", code: 1, userInfo: [NSLocalizedDescriptionKey: "no converter"]) }
        let stdout = FileHandle.standardOutput
        input.installTap(onBus: 0, bufferSize: 2048, format: inFmt) { buf, _ in
            guard let src = buf.floatChannelData, let mono = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: buf.frameLength) else { return }
            mono.frameLength = buf.frameLength
            memcpy(mono.floatChannelData![0], src[0], Int(buf.frameLength) * MemoryLayout<Float>.size)
            let cap = AVAudioFrameCount(Double(buf.frameLength) * 16000 / inFmt.sampleRate) + 32
            guard let ob = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
            var fed = false
            var err: NSError?
            conv.convert(to: ob, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true; status.pointee = .haveData; return mono
            }
            if ob.frameLength > 0, let p = ob.int16ChannelData {
                stdout.write(Data(bytes: p[0], count: Int(ob.frameLength) * 2))
            }
        }
        try engine.start()
        FileHandle.standardError.write("ready \(inFmt.channelCount)ch \(Int(inFmt.sampleRate))Hz\n".data(using: .utf8)!)
    } catch {
        FileHandle.standardError.write("error: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(1)
    }
    signal(SIGPIPE, SIG_IGN)
    withExtendedLifetime(engine) { RunLoop.main.run() }
}

let args = CommandLine.arguments
if args.count > 1, args[1] == "mic" { runMic(aec: !(args.count > 2 && args[2] == "--no-aec")) }

let out = Out()
var streamRef: SCStream?
Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw NSError(domain: "sysaudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"]) }
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.sampleRate = 16000
        cfg.channelCount = 1
        cfg.excludesCurrentProcessAudio = true
        cfg.width = 2; cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: out)
        try stream.addStreamOutput(out, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio"))
        try stream.addStreamOutput(out, type: .screen, sampleHandlerQueue: DispatchQueue(label: "screen"))
        try await stream.startCapture()
        streamRef = stream
        FileHandle.standardError.write("ready\n".data(using: .utf8)!)
    } catch {
        FileHandle.standardError.write("error: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(1)
    }
}
signal(SIGPIPE, SIG_IGN)
RunLoop.main.run()
