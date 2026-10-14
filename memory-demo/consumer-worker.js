// Consumer (stands in for the render worker): receives slices from the producer and draws the latest one
// on an OffscreenCanvas once per frame, like the chart renderer does.
//
// Main thread -> INIT { canvas, port }
// Producer    -> RUN / SLICE / SHARED / END (see producer-worker.js)
// -> Producer    RELEASE { ohlcvBuffer, indicatorBuffers }  (transfer-pool mode)
// -> Main thread STATS { ... }

import OHLCVStore, { Field } from '../ohlcv-store.js';
import { createLiveBytes } from './live-bytes.js';

const STATS_MS = 250;
const BAR_WIDTH = 3;

let canvas;
let ctx;
let port;
let mode;
let leak = false;
let latest;      // { store, indicators } drawn on the next frame
let drawnVersion = -1;
let dirty = false;
let retained = []; // Leak simulation: every slice ever received stays reachable
let stats = createStats();
const live = createLiveBytes();

self.addEventListener('message', (event) => {
    const { msgType, data } = event.data;

    if (msgType === 'INIT') {
        canvas = data.canvas;
        ctx = canvas.getContext('2d');
        port = data.port;
        port.onmessage = onProducerMessage;
        setInterval(postStats, STATS_MS);
        requestFrame();
    }
});

function onProducerMessage(event) {
    const { msgType, data } = event.data;

    switch (msgType) {
        case 'RUN':
            mode = data.mode;
            leak = data.leak;
            latest = undefined;
            retained = [];
            stats = createStats();
            break;

        case 'SLICE':
            onSlice(data);
            break;

        case 'SHARED':
            latest = wrap(data);
            drawnVersion = -1;
            break;

        case 'END':
            // The last slice stays on screen; the producer drops its pool when a run ends
            break;
    }
}

function onSlice(data) {
    stats.received++;
    stats.bytesReceived += data.ohlcvBuffer.byteLength + data.indicatorBuffers.reduce((sum, b) => sum + b.byteLength, 0);
    stats.latencyMs = performance.timeOrigin + performance.now() - data.sentAt;

    live.track(data.ohlcvBuffer);
    data.indicatorBuffers.forEach(live.track);

    const previous = latest;

    latest = wrap(data);
    dirty = true;

    if (leak) {
        retained.push(latest);
        stats.retainedBytes += latest.store.buffer.byteLength + latest.indicators.reduce((sum, s) => sum + s.byteLength, 0);
        return;
    }

    // Frames are drawn from `latest` only, so the slice it replaced can go back to the producer right away
    if (mode === 'transfer-pool' && previous) {
        const ohlcvBuffer = previous.store.buffer;
        const indicatorBuffers = previous.indicators.map((series) => series.buffer);

        const transfer = [ohlcvBuffer, ...indicatorBuffers];

        transfer.forEach(live.untrack);
        port.postMessage({ msgType: 'RELEASE', data: { ohlcvBuffer, indicatorBuffers } }, transfer);
        stats.released++;
    }
}

function wrap({ ohlcvBuffer, indicatorBuffers }) {
    return {
        store: OHLCVStore.from(ohlcvBuffer),
        indicators: indicatorBuffers.map((buffer) => new Float64Array(buffer))
    };
}

// ---- Drawing ----

function requestFrame() {
    if (typeof self.requestAnimationFrame === 'function') {
        self.requestAnimationFrame(onFrame);
    } else {
        setTimeout(onFrame, 16);
    }
}

function onFrame() {
    requestFrame();

    if (!latest) {
        return;
    }

    if (latest.store.isShared) {
        const version = latest.store.version;

        if (version === drawnVersion || !latest.store.tryRead(draw)) {
            return;
        }

        drawnVersion = version;
    } else if (dirty) {
        draw(latest.store);
        dirty = false;
    } else {
        return;
    }

    stats.frames++;
}

// Draws the newest bars that fit, plus the first indicator as a line
function draw(store) {
    const { width, height } = canvas;
    const count = store.length;
    const visible = Math.min(count, Math.floor(width / BAR_WIDTH));
    const first = count - visible;
    const sma = latest.indicators[0];

    let min = Infinity;
    let max = -Infinity;

    for (let i = first; i < count; i++) {
        min = Math.min(min, store.get(i, Field.LOW));
        max = Math.max(max, store.get(i, Field.HIGH));
    }

    const range = max - min || 1;
    const toY = (price) => 10 + (max - price) / range * (height - 20);

    ctx.fillStyle = '#010736';
    ctx.fillRect(0, 0, width, height);

    for (let i = first; i < count; i++) {
        const x = (i - first) * BAR_WIDTH;
        const open = store.get(i, Field.OPEN);
        const close = store.get(i, Field.CLOSE);

        ctx.fillStyle = close >= open ? '#00C853' : '#FF5252';
        ctx.fillRect(x, toY(store.get(i, Field.HIGH)), 1, Math.max(1, toY(store.get(i, Field.LOW)) - toY(store.get(i, Field.HIGH))));
        ctx.fillRect(x - 1, toY(Math.max(open, close)), BAR_WIDTH - 1, Math.max(1, Math.abs(toY(open) - toY(close))));
    }

    if (sma) {
        ctx.strokeStyle = '#ffd54f';
        ctx.beginPath();

        for (let i = first; i < count; i++) {
            const x = (i - first) * BAR_WIDTH;

            if (i === first) {
                ctx.moveTo(x, toY(sma[i]));
            } else {
                ctx.lineTo(x, toY(sma[i]));
            }
        }

        ctx.stroke();
    }
}

function createStats() {
    return { received: 0, bytesReceived: 0, released: 0, frames: 0, latencyMs: 0, retainedBytes: 0 };
}

function postStats() {
    self.postMessage({ msgType: 'STATS', data: { ...stats, retainedSlices: retained.length, liveBytes: live.counter.bytes, collected: live.counter.collected } });
}

