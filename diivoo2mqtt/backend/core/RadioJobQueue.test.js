const test = require('node:test');
const assert = require('node:assert/strict');

const {
    RadioJobQueue,
    QueueTimeoutError,
    QueueOverflowError,
} = require('./RadioJobQueue');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForAbort(signal) {
    if (signal.aborted) {
        throw signal.reason;
    }

    return new Promise((_, reject) => {
        signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
        );
    });
}

test('runs only one job at a time', async () => {
    const queue = new RadioJobQueue();
    let active = 0;
    let maxActive = 0;
    const order = [];

    const makeJob = (name, delay) => queue.enqueue(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${name}`);
        await sleep(delay);
        order.push(`end:${name}`);
        active--;
        return name;
    });

    const results = await Promise.all([
        makeJob('a', 30),
        makeJob('b', 10),
        makeJob('c', 10),
    ]);

    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, [
        'start:a', 'end:a',
        'start:b', 'end:b',
        'start:c', 'end:c',
    ]);
});

test('respects priority and FIFO within same priority', async () => {
    const queue = new RadioJobQueue();
    const order = [];

    const first = queue.enqueue(async () => {
        order.push('run:first');
        await sleep(25);
        return 'first';
    }, { id: 'first', priority: 0 });

    const low1 = queue.enqueue(async () => {
        order.push('run:low1');
        return 'low1';
    }, { id: 'low1', priority: 1 });

    const high = queue.enqueue(async () => {
        order.push('run:high');
        return 'high';
    }, { id: 'high', priority: 10 });

    const low2 = queue.enqueue(async () => {
        order.push('run:low2');
        return 'low2';
    }, { id: 'low2', priority: 1 });

    const results = await Promise.all([first, low1, high, low2]);

    assert.deepEqual(results, ['first', 'low1', 'high', 'low2']);
    assert.deepEqual(order, ['run:first', 'run:high', 'run:low1', 'run:low2']);
});

test('times out while waiting to acquire queue slot', async () => {
    const queue = new RadioJobQueue();

    const blocker = queue.enqueue(async () => {
        await sleep(80);
        return 'blocker';
    }, {
        id: 'blocker',
        executionTimeoutMs: 500,
    });

    const timedOut = queue.enqueue(async () => 'late', {
        id: 'late',
        acquireTimeoutMs: 20,
    });

    await assert.rejects(timedOut, (err) => {
        assert.ok(err instanceof QueueTimeoutError);
        assert.equal(err.code, 'ACQUIRE_TIMEOUT');
        return true;
    });

    assert.equal(await blocker, 'blocker');
});

test('aborts execution on execution timeout but waits for cleanup before next job', async () => {
    const queue = new RadioJobQueue();
    const order = [];

    const slow = queue.enqueue(async ({ signal }) => {
        order.push('slow:start');
        try {
            await waitForAbort(signal);
        } finally {
            order.push('slow:cleanup:start');
            await sleep(30);
            order.push('slow:cleanup:end');
        }
    }, {
        id: 'slow',
        executionTimeoutMs: 20,
    });

    const fast = queue.enqueue(async () => {
        order.push('fast:start');
        return 'fast';
    }, { id: 'fast' });

    await assert.rejects(slow, (err) => {
        assert.ok(err instanceof QueueTimeoutError);
        assert.equal(err.code, 'EXECUTION_TIMEOUT');
        return true;
    });

    assert.equal(await fast, 'fast');
    assert.deepEqual(order, [
        'slow:start',
        'slow:cleanup:start',
        'slow:cleanup:end',
        'fast:start',
    ]);
});

test('continues after a failing job', async () => {
    const queue = new RadioJobQueue();
    const order = [];

    const bad = queue.enqueue(async () => {
        order.push('bad');
        throw new Error('boom');
    });

    const good = queue.enqueue(async () => {
        order.push('good');
        return 42;
    });

    await assert.rejects(bad, /boom/);
    assert.equal(await good, 42);
    assert.deepEqual(order, ['bad', 'good']);
});

test('rejects when queue is full', async () => {
    const queue = new RadioJobQueue({ maxQueueSize: 2 });

    const first = queue.enqueue(async () => {
        await sleep(40);
        return 'first';
    });

    const second = queue.enqueue(async () => 'second');
    const third = queue.enqueue(async () => 'third');

    await assert.rejects(third, (err) => {
        assert.ok(err instanceof QueueOverflowError);
        assert.equal(err.code, 'QUEUE_OVERFLOW');
        return true;
    });

    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
});

test('execution timeout is cooperative when handler ignores abort signal', async () => {
    const queue = new RadioJobQueue();
    const order = [];

    const slow = queue.enqueue(async () => {
        order.push('slow:start');
        await sleep(40); // ignores abort signal completely
        order.push('slow:end');
        return 'slow-finished';
    }, {
        id: 'slow',
        executionTimeoutMs: 10,
    });

    const next = queue.enqueue(async () => {
        order.push('next:start');
        return 'next';
    });

    assert.equal(await slow, 'slow-finished');
    assert.equal(await next, 'next');

    assert.deepEqual(order, [
        'slow:start',
        'slow:end',
        'next:start',
    ]);
});