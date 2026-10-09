// Data worker: owns the OHLCV store and indicator outputs, does all data I/O and calculations.
//
// Main thread  -> INIT { port, capacity }, LOAD { symbol, interval }
// Renderer     -> VIEWPORT { rightOffset, visibleCount }  (bars back from the latest bar, bars on screen)
// -> Renderer     DATA_SHARED { ohlcvBuffer, indicatorBuffers }            (once, shared memory)
//                 DATA_SLICE  { ohlcvBuffer, indicatorBuffers, startIndex, totalCount } (fallback)
// -> Main thread  STATUS { ... }

import OHLCVStore, { Field } from './ohlcv-store.js';
import { createSeries, calculateSMA } from './indicators.js';

const SMA_PERIOD = 20;
const FEED_TICK_MS = 800;
const TICKS_PER_BAR = 10;

let rendererPort;
let store;
let indicators;
let viewport = { rightOffset: 0, visibleCount: 200 };
let feedTimer;
let barInterval = 60;

self.addEventListener('message', async (event) => {
    const { msgType, data } = event.data;

    switch (msgType) {
        case 'INIT':
            init(data);
            break;

        case 'LOAD':
            await load(data.symbol, data.interval);
            break;

        default:
            console.warn('Data worker: unknown message', msgType);
    }
});

function init({ port, capacity }) {
    store = OHLCVStore.create(capacity);
    indicators = {
        sma: createSeries(capacity, store.isShared)
    };

    rendererPort = port;
    rendererPort.onmessage = onRendererMessage;

    if (store.isShared) {
        // Shared memory: hand the buffers over once, the renderer reads them directly from then on
        rendererPort.postMessage({
            msgType: 'DATA_SHARED',
            data: {
                ohlcvBuffer: store.buffer,
                indicatorBuffers: mapIndicators((series) => series.buffer)
            }
        });
    }

    self.postMessage({ msgType: 'STATUS', data: { ready: true, sharedMemory: store.isShared } });
}

function onRendererMessage(event) {
    const { msgType, data } = event.data;

    switch (msgType) {
        case 'VIEWPORT':
            viewport = data;

            // This is also where older history would be requested when the viewport reaches the first bar
            if (!store.isShared) {
                sendSlice();
            }
            break;

        default:
            console.warn('Data worker: unknown renderer message', msgType);
    }
}

async function load(symbol, interval) {
    stopFeed();
    barInterval = interval;

    const bars = await fetchHistory(symbol, interval);

    store.write((s) => {
        s.clear();

        for (const bar of bars) {
            s.push(...bar);
        }

        calculateSMA(s, indicators.sma, SMA_PERIOD);
    });

    publish();
    self.postMessage({ msgType: 'STATUS', data: { symbol, bars: store.length } });

    startFeed();
}

// Replace with a real API call, e.g.:
//   const response = await fetch(`/api/history?symbol=${symbol}&interval=${interval}`);
//   return parse(await response.arrayBuffer());
async function fetchHistory(symbol, interval, barCount = 50000) {
    const bars = [];
    let time = Math.floor(Date.now() / 1000 / interval) * interval - barCount * interval;
    let open = 27.5;

    for (let i = 0; i < barCount; i++) {
        const bar = randomBar(time, open);

        bars.push(bar);
        open = bar[Field.CLOSE];
        time += interval;
    }

    return bars;
}

// Replace with a real WebSocket subscription; each message would go through applyTick()
function startFeed() {
    let ticks = 0;

    feedTimer = setInterval(() => {
        const last = store.length - 1;
        const lastClose = store.get(last, Field.CLOSE);

        if (++ticks % TICKS_PER_BAR === 0) {
            applyTick({ newBar: randomBar(store.get(last, Field.TIME) + barInterval, lastClose) });
        } else {
            applyTick({ price: Math.max(0.01, lastClose + (Math.random() - 0.5) * 0.05), volume: Math.round(Math.random() * 500) });
        }
    }, FEED_TICK_MS);
}

function stopFeed() {
    clearInterval(feedTimer);
}

// One live update: either a trade on the current bar or the start of a new bar
function applyTick({ price, volume, newBar }) {
    if (store.length >= store.capacity) {
        // A production store would be a ring buffer or grow here
        stopFeed();
        console.warn('Data worker: store is full, live feed stopped');
        return;
    }

    store.write((s) => {
        let changedIndex;

        if (newBar) {
            changedIndex = s.push(...newBar);
        } else {
            changedIndex = s.length - 1;
            s.set(changedIndex, Field.CLOSE, price);
            s.set(changedIndex, Field.HIGH, Math.max(s.get(changedIndex, Field.HIGH), price));
            s.set(changedIndex, Field.LOW, Math.min(s.get(changedIndex, Field.LOW), price));
            s.set(changedIndex, Field.VOLUME, s.get(changedIndex, Field.VOLUME) + volume);
        }

        // Only bars from changedIndex onwards are affected
        calculateSMA(s, indicators.sma, SMA_PERIOD, changedIndex);
    });

    publish();
}

// Shared memory needs no message: the renderer notices the version change on its next frame
function publish() {
    if (!store.isShared) {
        sendSlice();
    }
}

// Fallback without shared memory: send copies of the visible range plus a margin on each side,
// so the renderer can keep panning smoothly until the next slice arrives
function sendSlice() {
    const count = store.length;
    const span = viewport.visibleCount;
    const visibleTo = Math.max(0, count - viewport.rightOffset);
    const to = Math.min(count, visibleTo + span);
    const from = Math.max(0, visibleTo - span * 2);
    const slice = store.slice(from, to);
    const indicatorBuffers = mapIndicators((series) => series.slice(from, to).buffer);

    rendererPort.postMessage({
        msgType: 'DATA_SLICE',
        data: {
            ohlcvBuffer: slice.buffer,
            indicatorBuffers,
            startIndex: from,
            totalCount: count
        }
    }, [slice.buffer, ...Object.values(indicatorBuffers)]);
}

function mapIndicators(fn) {
    return Object.fromEntries(Object.entries(indicators).map(([name, series]) => [name, fn(series)]));
}

function randomBar(time, open) {
    const close = Math.max(0.01, open + (Math.random() - 0.5) * 0.4);
    const high = Math.max(open, close) + Math.random() * 0.1;
    const low = Math.max(0.01, Math.min(open, close) - Math.random() * 0.1);
    const volume = Math.round(Math.random() * 50000);

    return [time, open, high, low, close, volume];
}
