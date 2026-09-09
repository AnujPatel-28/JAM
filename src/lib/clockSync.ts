import { insforge } from './insforge';

let offsetMs = 0;
let calibrated = false;
let calibratingPromise: Promise<number> | null = null;

/**
 * Cristian's Algorithm Clock Synchronization.
 * Takes 3 RTT samples against PostgreSQL `get_server_time()`,
 * discards the outlier with the highest RTT, and averages the remaining offsets.
 * Guarantees host and listeners calculate drift against a single shared temporal baseline.
 */
export async function calibrateClock(): Promise<number> {
  if (calibratingPromise) return calibratingPromise;

  calibratingPromise = (async () => {
    const samples: { rtt: number; offset: number }[] = [];

    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      try {
        const { data, error } = await insforge.database.rpc('get_server_time');
        const t1 = Date.now();

        if (!error && data) {
          const serverMs = new Date(data as string).getTime();
          const rtt = Math.max(1, t1 - t0);
          // Cristian's formula: server_time + (rtt / 2) - client_receive_time
          const offset = serverMs + rtt / 2 - t1;
          samples.push({ rtt, offset });
        }
      } catch (err) {
        console.warn('Clock calibration sample failed:', err);
      }

      if (i < 2) {
        // 80ms interval to prevent request clustering
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }

    if (samples.length > 0) {
      // Sort by RTT ascending (lower RTT = higher precision)
      samples.sort((a, b) => a.rtt - b.rtt);
      // Discard highest RTT sample if we have 3 samples
      const validSamples = samples.length >= 3 ? samples.slice(0, 2) : samples;
      const avgOffset =
        validSamples.reduce((sum, s) => sum + s.offset, 0) / validSamples.length;

      offsetMs = Math.round(avgOffset);
      calibrated = true;
      console.log(
        `[ClockSync] Calibrated offset: ${offsetMs}ms (best RTT: ${samples[0].rtt}ms, ${validSamples.length} samples)`
      );
    } else {
      console.warn('[ClockSync] Calibration failed — defaulting offset to 0ms.');
    }

    calibratingPromise = null;
    return offsetMs;
  })();

  return calibratingPromise;
}

/**
 * Returns the current time in milliseconds adjusted by the server clock offset.
 */
export function getServerNow(): number {
  return Date.now() + offsetMs;
}

/**
 * Returns whether clock calibration has successfully completed.
 */
export function isClockCalibrated(): boolean {
  return calibrated;
}

/**
 * Current offset in milliseconds (positive means server is ahead of client).
 */
export function getClockOffsetMs(): number {
  return offsetMs;
}
