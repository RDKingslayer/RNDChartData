// Indicator calculations. Each output series is a Float64Array aligned with the
// OHLCV store, so out[i] belongs to bar i. Bars without enough history are NaN.

export function createSeries(capacity, shared) {
    const byteLength = capacity * Float64Array.BYTES_PER_ELEMENT;
    const series = new Float64Array(shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength));

    series.fill(NaN);

    return series;
}

// Simple moving average of the close price, recalculated from fromIndex to the last bar.
// Pass the index of the first changed bar to keep live updates cheap.
export function calculateSMA(store, out, period, fromIndex = 0) {
    const count = store.length;
    const close = store.close;

    for (let i = fromIndex; i < count; i++) {
        if (i < period - 1) {
            out[i] = NaN;
            continue;
        }

        let sum = 0;

        for (let j = i - period + 1; j <= i; j++) {
            sum += close[j];
        }

        out[i] = sum / period;
    }
}
