import { describe, it, expect } from "vitest";
import { encodeWav } from "./wav-encoder";

function readString(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe("encodeWav", () => {
  it("writes a valid RIFF/WAVE header", async () => {
    const chunk = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav([chunk], 16000);
    const view = new DataView(await blob.arrayBuffer());

    expect(blob.type).toBe("audio/wav");
    expect(readString(view, 0, 4)).toBe("RIFF");
    expect(readString(view, 8, 4)).toBe("WAVE");
    expect(readString(view, 12, 4)).toBe("fmt ");
    expect(readString(view, 36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("keeps the sample rate when already at or below the target", async () => {
    const blob = encodeWav([new Float32Array([0, 0, 0, 0])], 16000);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint32(24, true)).toBe(16000);
    // 4 samples * 2 bytes
    expect(view.getUint32(40, true)).toBe(8);
  });

  it("downsamples higher input rates to 16 kHz and halves nothing it cannot", async () => {
    const input = new Float32Array(48000).fill(0.25);
    const blob = encodeWav([input], 48000);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint32(24, true)).toBe(16000);
    // 48000 samples at ratio 3 -> 16000 samples -> 32000 bytes
    expect(view.getUint32(40, true)).toBe(32000);
  });

  it("concatenates multiple chunks", async () => {
    const blob = encodeWav([new Float32Array([0.1, 0.2]), new Float32Array([0.3])], 16000);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint32(40, true)).toBe(6); // 3 samples * 2 bytes
  });
});
