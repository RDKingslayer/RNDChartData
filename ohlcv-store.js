// Fixed-capacity OHLCV store backed by a single (Shared)ArrayBuffer.
//
// Memory layout:
//   bytes 0..15  header  Int32Array [version, count, capacity, reserved]
//   bytes 16..   rows    Float64Array, STRIDE values per row:
//                        [time, open, high, low, close, volume]
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

export const STRIDE = 6;

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
        const byteLength = HEADER_BYTES + capacity * STRIDE * Float64Array.BYTES_PER_ELEMENT;
        const buffer = shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
        const store = new OHLCVStore(buffer);

        Atomics.store(store.header, CAPACITY, capacity);

        return store;
    }

    static from(buffer) {
        return new OHLCVStore(buffer);
    }

    constructor(buffer) {
        this.buffer = buffer;
        this.isShared = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
        this.header = new Int32Array(buffer, 0, HEADER_INTS);
        this.data = new Float64Array(buffer, HEADER_BYTES);
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
        const offset = index * STRIDE;

        this.data[offset + Field.TIME] = time;
        this.data[offset + Field.OPEN] = open;
        this.data[offset + Field.HIGH] = high;
        this.data[offset + Field.LOW] = low;
        this.data[offset + Field.CLOSE] = close;
        this.data[offset + Field.VOLUME] = volume;
    }

    set(index, field, value) {
        this.data[index * STRIDE + field] = value;
    }

    // Copies rows [from, to) into a new, non-shared store, e.g. to transfer to another thread
    slice(from, to) {
        const count = Math.max(0, to - from);
        const copy = OHLCVStore.create(Math.max(count, 1), false);

        copy.data.set(this.data.subarray(from * STRIDE, to * STRIDE));
        Atomics.store(copy.header, COUNT, count);

        return copy;
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
        return this.data[index * STRIDE + field];
    }

    getRow(index) {
        const offset = index * STRIDE;

        return {
            time: this.data[offset + Field.TIME],
            open: this.data[offset + Field.OPEN],
            high: this.data[offset + Field.HIGH],
            low: this.data[offset + Field.LOW],
            close: this.data[offset + Field.CLOSE],
            volume: this.data[offset + Field.VOLUME]
        };
    }
}
