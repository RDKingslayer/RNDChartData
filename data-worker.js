// Data worker: owns the OHLCV store and indicator outputs, does all data I/O and calculations.
//
// Main thread  -> INIT { port, capacity }, LOAD { symbol, interval }
// Renderer     -> VIEWPORT { rightOffset, visibleCount }  (bars back from the latest bar, bars on screen)
//                 RELEASE  { ohlcvBuffer, indicatorBuffers }  (fallback: a slice the renderer no longer needs)
// -> Renderer     DATA_SHARED { ohlcvBuffer, indicatorBuffers }            (once, shared memory)
//                 DATA_SLICE  { ohlcvBuffer, indicatorBuffers, startIndex, totalCount } (fallback)
//                 DATA_DELTA  { startIndex, rows, indicatorValues, totalCount }        (fallback, live updates)
// -> Main thread  STATUS { ... }
//
// Fallback buffers ping-pong: every DATA_SLICE is transferred to the renderer, which transfers the
// previous one back with RELEASE, so slices are filled into recycled buffers instead of new ones.
// Live ticks only send the changed rows (DATA_DELTA), which the renderer writes into its current slice.

import OHLCVStore, { Field, STRIDE } from './ohlcv-store.js';
import { createSeries, calculateSMA } from './indicators.js';

const SMA_PERIOD = 20;
const FEED_TICK_MS = 800;
const TICKS_PER_BAR = 10;
const SLICE_HEADROOM = 64; // Spare rows in a slice buffer, so new bars can be appended by deltas
const SLICE_GROWTH = 1.25; // Extra size for new slice buffers, so they can be reused after zooming out a bit
const MAX_POOLED_SLICES = 3;

let rendererPort;
let store;
let indicators;
let viewport = { rightOffset: 0, visibleCount: 200 };
let feedTimer;
let barInterval = 60;

// Fallback only: what the renderer holds right now, in absolute bar indices [from, to), and recycled buffers
let rendererSlice = { from: 0, to: 0, capacity: 0 };
const slicePool = [];

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

        case 'RELEASE':
            recycleSlice(data);
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

    const changedIndex = store.write((s) => {
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

        return changedIndex;
    });

    publish(changedIndex);
}

// Shared memory needs no message: the renderer notices the version change on its next frame.
// Fallback: bars from changedIndex onwards changed, send just those if the renderer's slice can take them,
// otherwise (or with no changedIndex, e.g. after a full load) a whole new slice.
function publish(changedIndex) {
    if (store.isShared) {
        return;
    }

    if (changedIndex === undefined || !sendDelta(changedIndex)) {
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
    const { slice, indicatorSeries } = takeSlice(to - from);

    store.copyRange(from, to, slice);

    for (const [name, series] of Object.entries(indicatorSeries)) {
        series.set(indicators[name].subarray(from, to));
    }

    const indicatorBuffers = mapObject(indicatorSeries, (series) => series.buffer);

    rendererSlice = { from, to, capacity: slice.capacity };

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

// Sends the rows from changedIndex to the end that the renderer's slice can hold, as long as the visible
// range is still fully covered afterwards. Returns false when a whole new slice is needed instead.
function sendDelta(changedIndex) {
    const count = store.length;
    const { from, to, capacity } = rendererSlice;

    // Rows can only be overwritten or appended right after the slice's last row, up to its capacity.
    // If the slice ends before changedIndex (scrolled far back) there is nothing to write, only totalCount.
    const start = Math.max(changedIndex, from);
    const end = start <= to ? Math.min(count, from + capacity) : start;
    const newTo = Math.max(to, end);

    const visibleTo = Math.max(0, count - viewport.rightOffset);
    const visibleFrom = Math.max(0, visibleTo - viewport.visibleCount);

    if (visibleFrom < from || visibleTo > newTo) {
        return false;
    }

    const rows = store.data.slice(start * STRIDE, end * STRIDE);
    const indicatorValues = mapObject(indicators, (series) => series.slice(start, end));

    rendererSlice.to = newTo;

    rendererPort.postMessage({
        msgType: 'DATA_DELTA',
        data: { startIndex: start, rows, indicatorValues, totalCount: count }
    }, [rows.buffer, ...Object.values(indicatorValues).map((values) => values.buffer)]);

    return true;
}

// Smallest pooled slice buffer with room for rowCount rows plus headroom, or a new one
function takeSlice(rowCount) {
    const needed = rowCount + SLICE_HEADROOM;
    let best = -1;

    slicePool.forEach((entry, i) => {
        if (entry.slice.capacity >= needed && (best < 0 || entry.slice.capacity < slicePool[best].slice.capacity)) {
            best = i;
        }
    });

    if (best >= 0) {
        return slicePool.splice(best, 1)[0];
    }

    const capacity = Math.ceil(needed * SLICE_GROWTH);

    return {
        slice: OHLCVStore.create(capacity, false),
        indicatorSeries: mapObject(indicators, () => createSeries(capacity, false))
    };
}

// A slice buffer the renderer has finished with; keeps the largest few for reuse
function recycleSlice({ ohlcvBuffer, indicatorBuffers }) {
    slicePool.push({
        slice: OHLCVStore.from(ohlcvBuffer),
        indicatorSeries: mapObject(indicatorBuffers, (buffer) => new Float64Array(buffer))
    });

    if (slicePool.length > MAX_POOLED_SLICES) {
        slicePool.sort((a, b) => b.slice.capacity - a.slice.capacity);
        slicePool.length = MAX_POOLED_SLICES;
    }
}

function mapIndicators(fn) {
    return mapObject(indicators, fn);
}

function mapObject(object, fn) {
    return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, fn(value)]));
}

function randomBar(time, open) {
    const close = Math.max(0.01, open + (Math.random() - 0.5) * 0.4);
    const high = Math.max(open, close) + Math.random() * 0.1;
    const low = Math.max(0.01, Math.min(open, close) - Math.random() * 0.1);
    const volume = Math.round(Math.random() * 50000);

    return [time, open, high, low, close, volume];
}
