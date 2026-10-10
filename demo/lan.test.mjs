import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLanClient } from './lan.mjs';

const interfaces = [
  { address: '192.168.50.10', netmask: '255.255.255.0' },
  { address: '10.20.0.5', netmask: '255.255.0.0' },
];

test('allows this Mac and devices on its subnets', () => {
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.50.10', '192.168.50.23', '::ffff:192.168.50.200', '10.20.255.1']) {
    assert.equal(isLanClient(remote, interfaces), true, remote);
  }
});

test('refuses everything else', () => {
  for (const remote of [
    undefined,
    '',
    '192.168.51.10', // a different private subnet
    '10.21.0.1',
    '172.16.0.4',
    '8.8.8.8', // the internet
    '::ffff:8.8.8.8',
    '2001:db8::1', // IPv6 is not served
    'fe80::1',
    '192.168.50', // malformed
    '192.168.50.300',
  ]) {
    assert.equal(isLanClient(remote, interfaces), false, String(remote));
  }
});
