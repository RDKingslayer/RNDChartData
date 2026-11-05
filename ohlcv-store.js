// Fixed-capacity OHLCV store backed by a single (Shared)ArrayBuffer using a columnar layout.
//
// Memory layout:
//   bytes 0..15  header   Int32Array [version, count, capacity, reserved]
//   bytes 16..   columns  6 Float64Arrays, capacity values each:
//                         time, open, high, low, close, volume
//
// The same buffer can be wrapped on any thread with OHLCVStore.from(buffer).
//
// Concurrency model: one writer thread, any number of reader threads.
// The version field works as a sequence lock:
//   - write() makes it odd before changing anything and even again afterwards.
//   - tryRead() only trusts what it read if the version was even and unchanged.

export const Field = Object.freeze({
    TIME: 0,
    OPEN: 1,
    HIGH: 2,
    LOW: 3,
    CLOSE: 4,
    VOLUME: 5
});

export const NUM_FIELDS = 6;

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT; // 16, keeps the Float64Array 8-byte aligned
const VERSION = 0;
const COUNT = 1;
const CAPACITY = 2;

export function canShareMemory() {
    return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
}

export default class OHLCVStore {
    static create(capacity, shared = canShareMemory()) {
        const byteLength = HEADER_BYTES + capacity * NUM_FIELDS * Float64Array.BYTES_PER_ELEMENT;
        const buffer = shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
        const header = new Int32Array(buffer, 0, HEADER_INTS);

        Atomics.store(header, CAPACITY, capacity);

        return new OHLCVStore(buffer, capacity);
    }

    static from(buffer) {
        return new OHLCVStore(buffer);
    }

    constructor(buffer, initialCapacity) {
        this.buffer = buffer;
        this.isShared = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
        this.header = new Int32Array(buffer, 0, HEADER_INTS);

        const capacity = initialCapacity ?? Atomics.load(this.header, CAPACITY);
        const colBytes = capacity * Float64Array.BYTES_PER_ELEMENT;

        let offset = HEADER_BYTES;
        this.time = new Float64Array(buffer, offset, capacity); offset += colBytes;
        this.open = new Float64Array(buffer, offset, capacity); offset += colBytes;
        this.high = new Float64Array(buffer, offset, capacity); offset += colBytes;
        this.low = new Float64Array(buffer, offset, capacity); offset += colBytes;
        this.close = new Float64Array(buffer, offset, capacity); offset += colBytes;
        this.volume = new Float64Array(buffer, offset, capacity);

        this.columns = [this.time, this.open, this.high, this.low, this.close, this.volume];
    }

    get version() {
        return Atomics.load(this.header, VERSION);
    }

    get length() {
        return Atomics.load(this.header, COUNT);
    }

    get capacity() {
        return Atomics.load(this.header, CAPACITY);
    }

    // ---- Writer side (only the thread that owns the data calls these) ----

    // Groups any number of changes into one atomic-looking update for readers
    write(writer) {
        Atomics.add(this.header, VERSION, 1); // odd: write in progress

        try {
            return writer(this);
        } finally {
            Atomics.add(this.header, VERSION, 1); // even: consistent again
        }
    }

    clear() {
        Atomics.store(this.header, COUNT, 0);
    }

    push(time, open, high, low, close, volume) {
        const index = this.length;

        if (index >= this.capacity) {
            throw new RangeError(`OHLCVStore is full (capacity ${this.capacity})`);
        }

        this.setRow(index, time, open, high, low, close, volume);
        Atomics.store(this.header, COUNT, index + 1);

        return index;
    }

    setRow(index, time, open, high, low, close, volume) {
        this.time[index] = time;
        this.open[index] = open;
        this.high[index] = high;
        this.low[index] = low;
        this.close[index] = close;
        this.volume[index] = volume;
    }

    set(index, field, value) {
        this.columns[field][index] = value;
    }

    setColumns(index, columns) {
        const count = columns[0].length;
        const end = index + count;

        if (index > this.length || end > this.capacity) {
            throw new RangeError(`OHLCVStore: columns [${index}, ${end}) do not fit (count ${this.length}, capacity ${this.capacity})`);
        }

        for (let f = 0; f < NUM_FIELDS; f++) {
            this.columns[f].set(columns[f], index);
        }

        if (end > this.length) {
            Atomics.store(this.header, COUNT, end);
        }
    }

    // Writes whole rows starting at index, extending the count if they run past the end
    setRows(index, rows) {
        const rowCount = rows.length / NUM_FIELDS;
        const end = index + rowCount;

        if (index > this.length || end > this.capacity) {
            throw new RangeError(`OHLCVStore: rows [${index}, ${end}) do not fit (count ${this.length}, capacity ${this.capacity})`);
        }

        for (let i = 0; i < rowCount; i++) {
            const offset = i * NUM_FIELDS;
            const targetIdx = index + i;
            this.time[targetIdx] = rows[offset + Field.TIME];
            this.open[targetIdx] = rows[offset + Field.OPEN];
            this.high[targetIdx] = rows[offset + Field.HIGH];
            this.low[targetIdx] = rows[offset + Field.LOW];
            this.close[targetIdx] = rows[offset + Field.CLOSE];
            this.volume[targetIdx] = rows[offset + Field.VOLUME];
        }

        if (end > this.length) {
            Atomics.store(this.header, COUNT, end);
        }
    }

    // Replaces the contents of target with rows [from, to) of this store, e.g. to fill a buffer for another thread
    copyRange(from, to, target) {
        target.clear();
        const count = to - from;

        for (let f = 0; f < NUM_FIELDS; f++) {
            target.columns[f].set(this.columns[f].subarray(from, to), 0);
        }

        Atomics.store(target.header, COUNT, count);

        return target;
    }

    // ---- Reader side ----

    // Runs reader() and returns true if the data it saw was consistent.
    // Returns false without waiting if a write was in progress, so a render loop can
    // simply try again on the next frame instead of blocking.
    tryRead(reader) {
        const before = this.version;

        if (before & 1) {
            return false;
        }

        reader(this);

        return this.version === before;
    }

    get(index, field) {
        return this.columns[field][index];
    }

    getRow(index) {
        return {
            time: this.time[index],
            open: this.open[index],
            high: this.high[index],
            low: this.low[index],
            close: this.close[index],
            volume: this.volume[index]
        };
    }
}
