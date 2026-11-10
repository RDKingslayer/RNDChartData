// CPU benchmark for the two data delivery options with many charts on screen at once.
// Run with: node multi-chart-bench.mjs [charts]   (default 16 charts)
//
// Matches the chart's setup: one data worker thread owns every chart's data (30,000 rows each, OHLCV + SMA,
// 7 Float64 columns) and sends to one renderer instance per chart. All renderer instances live on the page's
// main thread, so here they share one thread, each with its own MessagePort.
// The renderers only receive and wrap the buffers; they do not draw.
//
// Each scenario sends one message per chart and is timed until the renderer has acknowledged all of them.

import { Worker, MessageChannel, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const COLS = 7;
const BYTES_PER_ROW = COLS * 8;
const ROWS = 30000;

if (!isMainThread) {
    // Renderer: wraps each buffer it receives and transfers it back (pooled) or just acknowledges it
    parentPort.on('message', ({ ports }) => {
        for (const port of ports) {
            port.on('message', ({ buffer, giveBack }) => {
                new Float64Array(buffer);

                if (giveBack) {
                    port.postMessage({ buffer }, [buffer]);
                } else {
                    port.postMessage({});
                }
            });
        }
    });
} else {
    const CHARTS = Number(process.argv[2] ?? 16);
    const GRID_COLUMNS = Math.ceil(Math.sqrt(CHARTS));

    // Option 2 window size, as in memory-estimate.mjs: 3x the visible bars plus headroom, 25% spare
    const PLOT_MARGIN_PX = 100;
    const visibleBars = (screenWidth, barSpacing) => Math.max(1, Math.floor((screenWidth / GRID_COLUMNS - PLOT_MARGIN_PX) / barSpacing));
    const windowRows = (visible) => Math.min(ROWS, Math.ceil((visible * 3 + 64) * 1.25));

    const worker = new Worker(fileURLToPath(import.meta.url));
    const channels = Array.from({ length: CHARTS }, () => new MessageChannel());
    const dataPorts = channels.map((c) => c.port1);

    worker.postMessage({ ports: channels.map((c) => c.port2) }, channels.map((c) => c.port2));

    // Every chart owns its own full dataset in the data worker
    const stores = Array.from({ length: CHARTS }, () => Array.from({ length: COLS }, () => {
        const col = new Float64Array(ROWS);
        for (let i = 0; i < ROWS; i++) col[i] = Math.random() * 30;
        return col;
    }));

    function fill(chart, target, rows, from) {
        for (let c = 0; c < COLS; c++) {
            new Float64Array(target, c * rows * 8, rows).set(stores[chart][c].subarray(from, from + rows));
        }
    }

    // One message per chart, all sent before waiting; resolves when every chart has answered
    function sendToAll(rows, pooled, pools, iteration) {
        return new Promise((resolve) => {
            let pending = CHARTS;

            for (let chart = 0; chart < CHARTS; chart++) {
                const port = dataPorts[chart];
                const buffer = pooled ? pools[chart] : new ArrayBuffer(rows * BYTES_PER_ROW);

                fill(chart, buffer, rows, iteration % (ROWS - rows + 1));

                port.once('message', (msg) => {
                    if (pooled) pools[chart] = msg.buffer;
                    if (--pending === 0) resolve();
                });
                port.postMessage({ buffer, giveBack: pooled }, [buffer]);
            }
        });
    }

    const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
    const p99 = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.99)];

    async function scenario(name, rows, pooled, iterations) {
        const pools = pooled ? Array.from({ length: CHARTS }, () => new ArrayBuffer(rows * BYTES_PER_ROW)) : undefined;
        const times = [];

        for (let i = 0; i < iterations; i++) {
            const t0 = performance.now();
            await sendToAll(rows, pooled, pools, i);
            times.push(performance.now() - t0);
        }

        const kb = (rows * BYTES_PER_ROW * CHARTS / 1024).toFixed(0);

        console.log(`${name.padEnd(48)} ${String(rows).padStart(6)} rows x ${CHARTS}  ${kb.padStart(6)} KB   ` +
            `all charts ${median(times).toFixed(3).padStart(7)} ms (p99 ${p99(times).toFixed(3)})   ` +
            `${(median(times) / 16.7 * 100).toFixed(1).padStart(5)}% of a frame`);
    }

    const cases = [
        ['1080p, default 6 px bars', visibleBars(1920, 6)],
        ['1080p, zoomed out at 2 px', visibleBars(1920, 2)],
        ['4K, zoomed out at 2 px', visibleBars(3840, 2)]
    ];

    console.log(`${CHARTS} charts in a ${GRID_COLUMNS}-column grid, ${ROWS.toLocaleString()} rows each, ` +
        'all renderer instances on one thread\n');
    console.log('Visible bars per chart: ' + cases.map(([name, v]) => `${name} ${v} (window ${windowRows(v)} rows)`).join(', ') + '\n');

    await scenario('warmup', 1000, true, 200);
    console.log('--- results ---');
    await scenario('Option 1: load all charts, full copy each', ROWS, false, 100);

    for (const [name, visible] of cases) {
        await scenario(`Option 2: load or refill all, ${name}`, windowRows(visible), true, 500);
    }

    await scenario('Live tick to every chart, either option', 1, true, 1000);
    console.log('\nOption 1 sends nothing during drag or zoom, so a synced drag of all charts costs 0 ms of data transfer.');

    await worker.terminate();
}
