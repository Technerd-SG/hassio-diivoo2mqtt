class QueueTimeoutError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'QueueTimeoutError';
        this.code = code;
    }
}

class QueueOverflowError extends Error {
    constructor(message = 'Queue is full') {
        super(message);
        this.name = 'QueueOverflowError';
        this.code = 'QUEUE_OVERFLOW';
    }
}

class RadioJobQueue {
    constructor(options = {}) {
        const {
            name = 'radio-queue',
            maxQueueSize = Infinity,
            now = () => Date.now(),
        } = options;

        this.name = name;
        this.maxQueueSize = Number.isFinite(maxQueueSize) ? maxQueueSize : Infinity;
        this._now = now;

        this._queue = [];
        this._running = false;
        this._sequence = 0;
        this._currentJob = null;
    }

    get size() {
        return this._queue.length + (this._running ? 1 : 0);
    }

    get waiting() {
        return this._queue.length;
    }

    get isBusy() {
        return this._running;
    }

    enqueue(handler, options = {}) {
        if (typeof handler !== 'function') {
            throw new TypeError('handler must be a function');
        }

        if (this.size >= this.maxQueueSize) {
            return Promise.reject(
                new QueueOverflowError(
                    `Queue '${this.name}' is full (max=${this.maxQueueSize})`
                )
            );
        }

        const sequence = ++this._sequence;

        const job = {
            id: options.id ?? `job-${sequence}`,
            priority: Number.isInteger(options.priority) ? options.priority : 0,
            acquireTimeoutMs: Number.isFinite(options.acquireTimeoutMs)
                ? Math.max(0, options.acquireTimeoutMs)
                : Infinity,
            executionTimeoutMs: Number.isFinite(options.executionTimeoutMs)
                ? Math.max(0, options.executionTimeoutMs)
                : Infinity,
            createdAt: this._now(),
            startedAt: null,
            sequence,
            handler,
            resolve: null,
            reject: null,
        };

        const promise = new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
        });

        this._queue.push(job);
        this._sortQueue();
        void this._drain();

        return promise;
    }

    _sortQueue() {
        this._queue.sort((a, b) => {
            if (a.priority !== b.priority) {
                return b.priority - a.priority;
            }
            if (a.createdAt !== b.createdAt) {
                return a.createdAt - b.createdAt;
            }
            return a.sequence - b.sequence;
        });
    }

    async _drain() {
        if (this._running) return;

        try {
            while (this._queue.length > 0) {
                const next = this._queue[0];
                const waitedMs = this._now() - next.createdAt;

                if (waitedMs > next.acquireTimeoutMs) {
                    this._queue.shift();
                    next.reject(
                        new QueueTimeoutError(
                            `Acquire timeout in queue '${this.name}' for job '${next.id}'`,
                            'ACQUIRE_TIMEOUT'
                        )
                    );
                    continue;
                }

                this._queue.shift();
                this._running = true;
                this._currentJob = next;
                next.startedAt = this._now();

                try {
                    const result = await this._runJob(next);
                    next.resolve(result);
                } catch (err) {
                    next.reject(err);
                } finally {
                    this._currentJob = null;
                    this._running = false;
                }
            }
        } catch (err) {
            // optional: zentral loggen oder rethrowen
            queueMicrotask(() => { throw err; });
        }
    }

    async _runJob(job) {
        const controller = new AbortController();
        let executionTimeout = null;

        if (Number.isFinite(job.executionTimeoutMs)) {
            executionTimeout = setTimeout(() => {
                controller.abort(
                    new QueueTimeoutError(
                        `Execution timeout in queue '${this.name}' for job '${job.id}'`,
                        'EXECUTION_TIMEOUT'
                    )
                );
            }, job.executionTimeoutMs);
        }

        try {
            return await job.handler({
                id: job.id,
                signal: controller.signal,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                priority: job.priority,
            });
        } finally {
            if (executionTimeout) {
                clearTimeout(executionTimeout);
            }
        }
    }
}

module.exports = {
    RadioJobQueue,
    QueueTimeoutError,
    QueueOverflowError,
};