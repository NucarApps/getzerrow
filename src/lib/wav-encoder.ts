// Pure PCM -> WAV helpers used by the in-person recorder. Kept free of DOM and
// Supabase imports so it stays unit-testable. Recording a standard 16-bit PCM
// WAV (instead of the browser's opaque MediaRecorder container) guarantees the
// clip is decodable by every browser and by the speech-to-text model — iOS
// Safari's fragmented MP4 otherwise fails to play back and makes the model
// hallucinate/loop.

const TARGET_SAMPLE_RATE = 16000;

/** Flatten an array of PCM frame chunks into one contiguous Float32Array. */
function concatChunks(chunks: Float32Array[]): Float32Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Naive linear decimation to the target sample rate (mono, good enough for STT). */
function downsample(samples: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (targetRate >= inputRate) return samples;
  const ratio = inputRate / targetRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    out[i] = samples[Math.floor(i * ratio)] ?? 0;
  }
  return out;
}

/**
 * Encode captured PCM frames into a 16 kHz mono 16-bit WAV blob.
 */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const merged = concatChunks(chunks);
  const samples = downsample(merged, sampleRate, TARGET_SAMPLE_RATE);
  const rate = sampleRate > TARGET_SAMPLE_RATE ? TARGET_SAMPLE_RATE : sampleRate;

  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
