import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerError } from './docker.ts';
import { removeWorkerNetwork } from './network-cleanup.ts';

const network = 'dsp_live_net_account';
const path = `/networks/${network}`;
const services = ['gateway', 'egress'];
type Step = { method: string; path: string; body?: unknown; result?: unknown; error?: Error };

function dockerScript(steps: Step[]) {
  let index = 0;
  return {
    async request(method: string, path: string, body?: unknown) {
      const step = steps[index++];
      assert.ok(step, `Unexpected Docker call: ${method} ${path}`);
      assert.deepEqual({ method, path, body }, { method: step.method, path: step.path, body: step.body });
      if (step.error) throw step.error;
      return step.result;
    },
    done() { assert.equal(index, steps.length); },
  };
}

test('cleanup skips the absent gateway and removes a partial account network', async () => {
  const script = dockerScript([
    { method: 'GET', path, result: { Containers: { egressId: { Name: 'egress' } } } },
    { method: 'POST', path: `${path}/disconnect`, body: { Container: 'egressId', Force: true } },
    { method: 'DELETE', path },
  ]);
  await removeWorkerNetwork(network, services, script.request);
  script.done();
});

test('cleanup disconnects both services before removing their network', async () => {
  const script = dockerScript([
    { method: 'GET', path, result: { Containers: { gatewayId: { Name: 'gateway' }, egressId: { Name: 'egress' } } } },
    { method: 'POST', path: `${path}/disconnect`, body: { Container: 'gatewayId', Force: true } },
    { method: 'POST', path: `${path}/disconnect`, body: { Container: 'egressId', Force: true } },
    { method: 'DELETE', path },
  ]);
  await removeWorkerNetwork(network, services, script.request);
  script.done();
});

test('cleanup succeeds when the network is already gone', async () => {
  const script = dockerScript([{ method: 'GET', path, error: new DockerError(404) }]);
  await removeWorkerNetwork(network, services, script.request);
  script.done();
});

test('cleanup accepts a concurrent detach only after confirming the endpoint disappeared', async () => {
  const script = dockerScript([
    { method: 'GET', path, result: { Containers: { gatewayId: { Name: 'gateway' } } } },
    { method: 'POST', path: `${path}/disconnect`, body: { Container: 'gatewayId', Force: true }, error: new DockerError(500, `container gatewayId is not connected to network ${network}`) },
    { method: 'GET', path, result: { Containers: {} } },
    { method: 'DELETE', path, error: new DockerError(404) },
  ]);
  await removeWorkerNetwork(network, services, script.request);
  script.done();
});

test('cleanup reports a disconnect failure when the endpoint is still attached', async () => {
  const info = { Containers: { gatewayId: { Name: 'gateway' } } };
  const error = new DockerError(500, `container gatewayId is not connected to network ${network}`);
  const script = dockerScript([
    { method: 'GET', path, result: info },
    { method: 'POST', path: `${path}/disconnect`, body: { Container: 'gatewayId', Force: true }, error },
    { method: 'GET', path, result: info },
  ]);
  await assert.rejects(removeWorkerNetwork(network, services, script.request), error);
  script.done();
});

for (const status of [403, 500]) {
  test(`cleanup propagates unexpected Docker ${status} failures`, async () => {
    const error = new DockerError(status, 'unexpected daemon failure');
    const script = dockerScript([
      { method: 'GET', path, result: { Containers: { gatewayId: { Name: 'gateway' } } } },
      { method: 'POST', path: `${path}/disconnect`, body: { Container: 'gatewayId', Force: true }, error },
    ]);
    await assert.rejects(removeWorkerNetwork(network, services, script.request), error);
    script.done();
  });
}

test('cleanup does not detach unrelated endpoints or hide network deletion failures', async () => {
  const error = new DockerError(409, 'network has active endpoints');
  const script = dockerScript([
    { method: 'GET', path, result: { Containers: { otherId: { Name: 'other' } } } },
    { method: 'DELETE', path, error },
  ]);
  await assert.rejects(removeWorkerNetwork(network, services, script.request), error);
  script.done();
});
