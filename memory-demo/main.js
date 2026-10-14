// Main thread: controls and stats only. Slices go producer -> consumer over a MessageChannel, as in the chart.

const TOTAL_BARS = 50000;
const BYTES_PER_ROW = 6 * 8;

const canvas = document.getElementById('chart');
const form = document.getElementById('controls');
const runButton = document.getElementById('run');
const stopButton = document.getElementById('stop');
const measureButton = document.getElementById('measure');
const perMessage = document.getElementById('perMessage');

const producer = createWorker('./producer-worker.js');
const consumer = createWorker('./consumer-worker.js');
const { port1, port2 } = new MessageChannel();

const producerStats = {};
const consumerStats = {};
let peakHeap = 0;
let peakBuffers = 0;

function createWorker(path) {
    const worker = new Worker(new URL(path, import.meta.url), { type: 'module' });

    worker.onerror = (e) => console.error(`${path} error:`, e.message, e);

    return worker;
}

const offscreen = canvas.transferControlToOffscreen();

consumer.postMessage({ msgType: 'INIT', data: { canvas: offscreen, port: port2 } }, [offscreen, port2]);
producer.postMessage({ msgType: 'INIT', data: { port: port1, totalBars: TOTAL_BARS } }, [port1]);

producer.onmessage = ({ data: { msgType, data } }) => {
    if (msgType === 'READY') {
        document.getElementById('isolation').textContent = self.crossOriginIsolated
            ? 'crossOriginIsolated: yes (SharedArrayBuffer available)'
            : 'crossOriginIsolated: no (shared mode disabled, enable COOP/COEP headers to use it)';
        form.mode.querySelector('[value="shared"]').disabled = !data.sharedMemory;
        // Like SharedArrayBuffer, measureUserAgentSpecificMemory only exists on cross-origin isolated pages
        measureButton.disabled = typeof performance.measureUserAgentSpecificMemory !== 'function';
        measureButton.title = measureButton.disabled ? 'Needs cross-origin isolation (COOP + COEP headers). Use the buffer counts above instead.' : '';
        runButton.disabled = false;
    } else if (msgType === 'STATS') {
        Object.assign(producerStats, data);
        render();
    }
};

consumer.onmessage = ({ data: { msgType, data } }) => {
    if (msgType === 'STATS') {
        Object.assign(consumerStats, data);
        render();
    }
};

function readConfig() {
    return {
        mode: form.mode.value,
        rate: Number(form.rate.value),
        rows: Number(form.rows.value),
        buffersPerMessage: Number(form.buffers.value),
        durationMs: Number(form.duration.value) * 1000,
        leak: form.leak.checked
    };
}

function updatePerMessage() {
    const { mode, rate, rows, buffersPerMessage, durationMs } = readConfig();

    if (mode === 'shared') {
        perMessage.textContent = 'Shared mode: no messages, the producer writes ticks into the shared buffer.';
        return;
    }

    const bytes = 16 + rows * BYTES_PER_ROW + (buffersPerMessage - 1) * rows * 8;
    const total = durationMs > 0 ? `, ${formatBytes(bytes * rate * durationMs / 1000)} in total` : '';

    const warning = bytes * rate > 1024 ** 3 ? '  (over 1 GB/s: expect a large spike, the tab may run out of memory)' : '';

    perMessage.textContent = `${buffersPerMessage} buffers, ${formatBytes(bytes)} per message, ` +
        `${formatBytes(bytes * rate)}/s${total}${warning}`;
}

form.addEventListener('input', updatePerMessage);

form.addEventListener('submit', (e) => {
    e.preventDefault();
    peakHeap = 0;
    peakBuffers = 0;
    producer.postMessage({ msgType: 'RUN', data: readConfig() });
});

stopButton.addEventListener('click', () => producer.postMessage({ msgType: 'STOP' }));

// Counts every agent (main thread and both workers), including ArrayBuffer backing stores.
// Needs cross-origin isolation; Chrome may delay the result by several seconds.
measureButton.addEventListener('click', async () => {
    const output = document.getElementById('measured');

    output.textContent = 'measuring (can take up to ~20 s)...';

    try {
        const result = await performance.measureUserAgentSpecificMemory();
        const lines = result.breakdown
            .filter((entry) => entry.bytes > 0)
            .map((entry) => `${formatBytes(entry.bytes).padStart(10)}  ${entry.attribution.map((a) => a.scope + ' ' + a.url.split('/').pop()).join(', ') || entry.types.join(', ')}`);

        output.textContent = `total ${formatBytes(result.bytes)}\n${lines.join('\n')}`;
    } catch (error) {
        output.textContent = `failed: ${error.message}`;
    }
});

function render() {
    const p = producerStats;
    const c = consumerStats;

    // performance.memory is Chrome-only and covers the main thread's JS heap, not the workers
    const heap = performance.memory?.usedJSHeapSize;

    if (heap) {
        peakHeap = Math.max(peakHeap, heap);
    }

    stopButton.disabled = !p.running;

    // Buffer bytes each worker holds, counted by the workers themselves (works without isolation)
    const buffers = (p.liveBytes ?? 0) + (c.liveBytes ?? 0);

    peakBuffers = Math.max(peakBuffers, buffers);

    document.getElementById('stats').textContent = [
        `producer   running ${p.running ? 'yes' : 'no'}   sent ${p.sent ?? 0}   ${formatBytes(p.bytesSent ?? 0)}`,
        `           new allocations ${p.allocated ?? 0} (${formatBytes(p.bytesAllocated ?? 0)})   reused ${p.reused ?? 0}   pool ${p.pooled ?? 0}`,
        `           copied by structured clone ${formatBytes(p.bytesCopied ?? 0)}`,
        `consumer   received ${c.received ?? 0}   ${formatBytes(c.bytesReceived ?? 0)}   released ${c.released ?? 0}   frames ${c.frames ?? 0}`,
        `           latency ${(c.latencyMs ?? 0).toFixed(1)} ms   leaked slices ${c.retainedSlices ?? 0} (${formatBytes(c.retainedBytes ?? 0)})`,
        `buffers    producer ${formatBytes(p.liveBytes ?? 0)}   consumer ${formatBytes(c.liveBytes ?? 0)}   total ${formatBytes(buffers)}   peak ${formatBytes(peakBuffers)}`,
        `           collected by GC: producer ${p.collected ?? 0}, consumer ${c.collected ?? 0}   (held = still referenced or not yet collected)`,
        heap ? `main heap  ${formatBytes(heap)}   peak ${formatBytes(peakHeap)}   (main thread only)` : 'main heap  n/a (performance.memory is Chrome-only)'
    ].join('\n');
}

function formatBytes(bytes) {
    if (bytes >= 1024 ** 3) {
        return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    }

    if (bytes >= 1024 ** 2) {
        return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    }

    return `${(bytes / 1024).toFixed(1)} KB`;
}

updatePerMessage();
render();
