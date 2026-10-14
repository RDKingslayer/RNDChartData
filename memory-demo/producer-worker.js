// Producer (stands in for the data worker): owns the full dataset and pushes slices to the consumer
// at a configurable rate, so memory can be watched in DevTools while buffers move between threads.
//
// Main thread -> INIT { port, totalBars }, RUN { mode, rate, rows, buffersPerMessage, durationMs, leak }, STOP
// Consumer    -> RELEASE { ohlcvBuffer, indicatorBuffers }   (pool mode: buffers coming back for reuse)
// -> Consumer    RUN { mode, leak }, SLICE { ohlcvBuffer, indicatorBuffers, startIndex, sentAt },
//                SHARED { ohlcvBuffer, indicatorBuffers }, END
// -> Main thread STATS { ... }
//
// Modes:
//   transfer-new   allocate new buffers for every message and transfer them (the consumer's copy is garbage later)
//   transfer-pool  transfer buffers and get them back with RELEASE, so they are reused (ping-pong)
//   clone          postMessage without a transfer list: the same scratch buffers are copied on every send
//   shared         SharedArrayBuffer handed over once, then only written to; no messages at all

import OHLCVStore, { Field, canShareMemory } from '../ohlcv-store.js';
import { createLiveBytes } from './live-bytes.js';

const TICK_MS = 10;
const MAX_SENDS_PER_TICK = 500; // Keeps a too-high rate from locking up the worker
const STATS_MS = 250;

let port;
let master;
let masterIndicators;
let run;
let timer;
let stats = createStats();
const pool = [];
const live = createLiveBytes();

self.addEventListener('message', (event) => {
    const { msgType, data } = event.data;

    switch (msgType) {
        case 'INIT':
            init(data);
            break;

        case 'RUN':
            start(data);
            break;

        case 'STOP':
            stop();
            break;
    }
});

function init({ port: consumerPort, totalBars }) {
    port = consumerPort;
    port.onmessage = onConsumerMessage;

    // Shared when the page is cross-origin isolated, so the same dataset also serves the "shared" mode
    master = OHLCVStore.create(totalBars, canShareMemory());
    masterIndicators = [];

    let price = 27.5;

    master.write((s) => {
        for (let i = 0; i < totalBars; i++) {
            const close = Math.max(0.01, price + (Math.random() - 0.5) * 0.4);

            s.push(i * 60, price, Math.max(price, close) + 0.05, Math.min(price, close) - 0.05, close, 1000);
            price = close;
        }
    });

    live.track(master.buffer);
    setInterval(postStats, STATS_MS);
    self.postMessage({ msgType: 'READY', data: { sharedMemory: master.isShared } });
}

function onConsumerMessage(event) {
    const { msgType, data } = event.data;

    if (msgType !== 'RELEASE') {
        return;
    }

    stats.released++;
    live.track(data.ohlcvBuffer);
    data.indicatorBuffers.forEach(live.track);

    // Buffers still in flight from a stopped run, or sized for a different one, are just dropped
    const fits = run && run.mode === 'transfer-pool' &&
        OHLCVStore.from(data.ohlcvBuffer).capacity >= run.rows &&
        data.indicatorBuffers.length === run.buffersPerMessage - 1;

    if (fits) {
        pool.push(data);
    }
}

function start(config) {
    stop();

    run = { ...config, startedAt: performance.now(), sent: 0, seq: 0 };
    stats = createStats();
    pool.length = 0;

    ensureIndicators(config.buffersPerMessage - 1);
    port.postMessage({ msgType: 'RUN', data: { mode: config.mode, leak: config.leak } });

    if (config.mode === 'shared') {
        port.postMessage({
            msgType: 'SHARED',
            data: { ohlcvBuffer: master.buffer, indicatorBuffers: masterIndicators.map((series) => series.buffer) }
        });
    } else if (config.mode === 'clone') {
        // One set of scratch buffers, copied by structured clone on every postMessage
        run.scratch = allocateSet(config.rows, config.buffersPerMessage - 1);
    }

    timer = setInterval(tick, TICK_MS);
}

function stop() {
    if (!run) {
        return;
    }

    clearInterval(timer);
    run = undefined;
    pool.length = 0; // Dropping the pool lets those buffers be collected after the run
    port.postMessage({ msgType: 'END' });
    postStats();
}

function tick() {
    const elapsed = performance.now() - run.startedAt;
    const done = run.durationMs > 0 && elapsed >= run.durationMs;
    const due = Math.floor(Math.min(elapsed, run.durationMs || elapsed) * run.rate / 1000) - run.sent;

    for (let i = 0; i < Math.min(due, MAX_SENDS_PER_TICK); i++) {
        sendOne();
    }

    if (done) {
        stop();
    }
}

function sendOne() {
    const { mode, rows } = run;
    const indicatorCount = run.buffersPerMessage - 1;

    run.sent++;
    run.seq++;
    stats.sent++;

    if (mode === 'shared') {
        // A live tick written in place; the consumer notices the version change on its next frame
        master.write((s) => {
            const last = s.length - 1;
            const close = s.get(last, Field.CLOSE) + (Math.random() - 0.5) * 0.05;

            s.set(last, Field.CLOSE, close);
            s.set(last, Field.HIGH, Math.max(s.get(last, Field.HIGH), close));
            s.set(last, Field.LOW, Math.min(s.get(last, Field.LOW), close));
        });
        return;
    }

    // Move the window a little every message, like panning or a new bar arriving
    const span = master.length - rows;
    const from = span > 0 ? (run.seq * 7) % span : 0;
    const to = Math.min(master.length, from + rows);
    let set;

    if (mode === 'clone') {
        set = run.scratch;
    } else if (mode === 'transfer-pool' && pool.length > 0) {
        set = wrapSet(pool.pop());
        stats.reused++;
    } else {
        set = allocateSet(rows, indicatorCount);
    }

    master.copyRange(from, to, set.store);
    set.indicators.forEach((series, k) => series.set(masterIndicators[k].subarray(from, to)));

    const data = {
        ohlcvBuffer: set.store.buffer,
        indicatorBuffers: set.indicators.map((series) => series.buffer),
        startIndex: from,
        sentAt: performance.timeOrigin + performance.now()
    };
    const bytes = data.ohlcvBuffer.byteLength + data.indicatorBuffers.reduce((sum, b) => sum + b.byteLength, 0);

    stats.bytesSent += bytes;

    if (mode === 'clone') {
        stats.bytesCopied += bytes;
        port.postMessage({ msgType: 'SLICE', data });
    } else {
        const transfer = [data.ohlcvBuffer, ...data.indicatorBuffers];

        transfer.forEach(live.untrack);
        port.postMessage({ msgType: 'SLICE', data }, transfer);
    }
}

function allocateSet(rows, indicatorCount) {
    stats.allocated++;
    stats.bytesAllocated += 16 + rows * 6 * 8 + indicatorCount * rows * 8;

    const set = {
        store: OHLCVStore.create(rows, false),
        indicators: Array.from({ length: indicatorCount }, () => new Float64Array(rows))
    };

    live.track(set.store.buffer);
    set.indicators.forEach((series) => live.track(series.buffer));

    return set;
}

function wrapSet({ ohlcvBuffer, indicatorBuffers }) {
    return {
        store: OHLCVStore.from(ohlcvBuffer),
        indicators: indicatorBuffers.map((buffer) => new Float64Array(buffer))
    };
}

// Indicator series over the whole dataset (simple moving closes), created once per count
function ensureIndicators(count) {
    while (masterIndicators.length < count) {
        const shift = masterIndicators.length + 1;
        const bytes = master.length * Float64Array.BYTES_PER_ELEMENT;
        const series = new Float64Array(master.isShared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));

        for (let i = 0; i < master.length; i++) {
            series[i] = master.get(Math.max(0, i - shift), Field.CLOSE);
        }

        live.track(series.buffer);
        masterIndicators.push(series);
    }
}

function createStats() {
    return { sent: 0, bytesSent: 0, bytesCopied: 0, allocated: 0, bytesAllocated: 0, reused: 0, released: 0 };
}

function postStats() {
    self.postMessage({ msgType: 'STATS', data: { ...stats, pooled: pool.length, running: Boolean(run), liveBytes: live.counter.bytes, collected: live.counter.collected } });
}
