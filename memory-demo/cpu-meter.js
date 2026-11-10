// Browsers have no per-thread CPU API, so each worker measures its own busy time: the wall-clock time spent
// inside the callbacks it wraps (timers, message handlers, frames). busy / elapsed is the share of one core
// the thread used, which is what a CPU column in a task manager would show for that thread.
//
// Not counted: work the browser does outside our callbacks, e.g. deserialising an incoming structured clone,
// and GC. Clone cost on the sending side (postMessage serialises synchronously) is counted.

// Smallest step performance.now() takes in this context, in microseconds. Browsers coarsen it (about 100 us, or
// 1 ms in some) unless the page is cross-origin isolated (about 5 us). Callbacks shorter than a step read as 0.
export function measureTimerResolution() {
    let smallest = Infinity;

    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        let now = start;

        while (now === start) {
            now = performance.now();
        }

        smallest = Math.min(smallest, now - start);
    }

    return smallest * 1000;
}

export function createCpuMeter() {
    let busyMs = 0;
    let peakPercent = 0;
    let lastSampleAt = performance.now();
    let lastSampleBusy = 0;
    let percent = 0;
    const resolutionUs = measureTimerResolution();

    return {
        // Wraps a callback so its run time is added to the busy total
        wrap(fn) {
            return function (...args) {
                const start = performance.now();

                try {
                    return fn.apply(this, args);
                } finally {
                    busyMs += performance.now() - start;
                }
            };
        },

        reset() {
            busyMs = 0;
            peakPercent = 0;
            percent = 0;
            lastSampleBusy = 0;
            lastSampleAt = performance.now();
        },

        // Call on a regular interval; the percentage covers the time since the previous call
        sample() {
            const now = performance.now();
            const wall = now - lastSampleAt;

            if (wall > 0) {
                percent = Math.min(100, (busyMs - lastSampleBusy) / wall * 100);
                peakPercent = Math.max(peakPercent, percent);
            }

            lastSampleAt = now;
            lastSampleBusy = busyMs;

            return { cpuBusyMs: busyMs, cpuPercent: percent, cpuPeakPercent: peakPercent, timerUs: resolutionUs };
        }
    };
}
