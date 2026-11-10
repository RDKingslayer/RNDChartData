// CPU benchmark for the two data delivery options: fills buffers in the OHLCV+SMA layout (7 Float64 columns)
// and transfers them between two threads. Run with: node transfer-bench.mjs
import { Worker, MessageChannel, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const COLS = 7;
const BYTES_PER_ROW = COLS * 8;

if (!isMainThread) {
    // Echo: receive a buffer, touch it the way a receiver wrapping it would, transfer it back
    parentPort.on('message', ({ port }) => {
        port.on('message', (msg) => {
            const buffer = msg.buffer ?? msg;
            new Float64Array(buffer);
            port.postMessage({ buffer }, [buffer]);
        });
    });
} else {
    const worker = new Worker(fileURLToPath(import.meta.url));
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ port: port2 }, [port2]);

    const TOTAL = 30000;
    const master = Array.from({ length: COLS }, () => {
        const col = new Float64Array(100000);
        for (let i = 0; i < col.length; i++) col[i] = Math.random() * 30;
        return col;
    });

    const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
    const p99 = (values) => values.sort((a, b) => a - b)[Math.floor(values.length * 0.99)];

    function fill(target, rows, from) {
        for (let c = 0; c < COLS; c++) {
            new Float64Array(target, c * rows * 8, rows).set(master[c].subarray(from, from + rows));
        }
    }

    const roundTrip = (buffer) => new Promise((resolve) => {
        port1.once('message', (msg) => resolve(msg.buffer));
        port1.postMessage({ buffer }, [buffer]);
    });

    async function scenario(name, rows, pooled, iterations) {
        const copy = [];
        const rt = [];
        let buffer = pooled ? new ArrayBuffer(rows * BYTES_PER_ROW) : undefined;

        for (let i = 0; i < iterations; i++) {
            const t0 = performance.now();
            const target = pooled ? buffer : new ArrayBuffer(rows * BYTES_PER_ROW);
            fill(target, rows, i % (TOTAL - rows + 1));
            const t1 = performance.now();
            const back = await roundTrip(target);
            const t2 = performance.now();

            if (pooled) buffer = back;
            copy.push(t1 - t0);
            rt.push(t2 - t1);
        }

        console.log(`${name.padEnd(42)} ${(rows * BYTES_PER_ROW / 1024).toFixed(0).padStart(6)} KB   ` +
            `fill ${median(copy).toFixed(3).padStart(7)} ms (p99 ${p99(copy).toFixed(3)})   ` +
            `transfer round trip ${median(rt).toFixed(3).padStart(7)} ms (p99 ${p99(rt).toFixed(3)})`);
    }

    // Warm up the JIT
    await scenario('warmup', 1000, true, 500);
    console.log('--- results ---');
    await scenario('option 1: whole dataset, new buffer', 30000, false, 300);
    await scenario('option 2: 1000 rows, pooled', 1000, true, 1000);
    await scenario('option 2: 2700 rows (3x span, 1080p out), pooled', 2700, true, 1000);
    await scenario('option 2: 5600 rows (3x span, 4K out), pooled', 5600, true, 1000);
    await scenario('live tick: 1 row', 1, true, 2000);

    // Per-frame work both options share: copying the visible columns for drawing
    const frame = [];
    for (let i = 0; i < 2000; i++) {
        const t0 = performance.now();
        for (let c = 0; c < COLS; c++) master[c].slice(1000, 1900);
        frame.push(performance.now() - t0);
    }
    console.log(`per-frame slice() of 900 visible bars: ${median(frame).toFixed(3)} ms (${(900 * BYTES_PER_ROW / 1024).toFixed(0)} KB allocated each frame)`);

    await worker.terminate();
}
