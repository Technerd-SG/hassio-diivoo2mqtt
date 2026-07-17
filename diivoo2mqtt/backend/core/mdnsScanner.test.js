const test = require('node:test');
const assert = require('node:assert/strict');
const MDnsScanner = require('./mdnsScanner');

function createFakeMdns() {
    return {
        handlers: {},
        queries: [],
        destroyed: false,
        on(event, handler) {
            this.handlers[event] = handler;
        },
        query(value) {
            this.queries.push(value);
        },
        destroy() {
            this.destroyed = true;
        },
    };
}

function gatewayResponse(ip = '10.0.0.20') {
    const serviceName = 'diivoo-gw-aabbccddeeff._diivoo._tcp.local';
    const target = 'diivoo-gw-aabbccddeeff.local';
    return {
        answers: [
            { type: 'PTR', name: '_diivoo._tcp.local', data: serviceName },
        ],
        additionals: [
            { type: 'SRV', name: serviceName, data: { port: 8080, target } },
            { type: 'A', name: target, data: ip },
        ],
    };
}

test('forgets a discovered address so it can be emitted again', () => {
    const mdns = createFakeMdns();
    const scanner = new MDnsScanner({ mdns });
    const found = [];
    scanner.on('gatewayFound', (gateway) => found.push(gateway));

    mdns.handlers.response(gatewayResponse());
    mdns.handlers.response(gatewayResponse());
    assert.equal(found.length, 1);

    scanner.forgetGateway('10.0.0.20');
    mdns.handlers.response(gatewayResponse());

    assert.equal(found.length, 2);
    assert.deepEqual(found[1], {
        id: 'diivoo-gw-aabbccddeeff',
        ip: '10.0.0.20',
        port: 8080,
    });
});
