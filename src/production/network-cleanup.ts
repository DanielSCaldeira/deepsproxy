import { docker, DockerError } from './docker.ts';

/** Remove only the account network; profile volumes are managed separately. */
export async function removeWorkerNetwork(network: string, containers: string[], request = docker) {
  const path = `/networks/${network}`;
  const inspect = async () => {
    try { return await request('GET', path); }
    catch (error) {
      if (error instanceof DockerError && error.status === 404) return null;
      throw error;
    }
  };
  const info = await inspect();
  if (!info) return;
  for (const [id, endpoint] of Object.entries(info.Containers || {}) as Array<[string, { Name: string }]>) {
    if (!containers.includes(endpoint.Name)) continue;
    try { await request('POST', `${path}/disconnect`, { Container: id, Force: true }); }
    catch (error) {
      if (error instanceof DockerError && error.status === 404) continue;
      // Another cleanup may detach the endpoint after inspection. Docker can
      // report this as 500; confirm it is gone before accepting that response.
      if (error instanceof DockerError && error.status === 500 && error.detail.includes('is not connected to network')) {
        const current = await inspect();
        if (!current?.Containers?.[id]) continue;
      }
      throw error;
    }
  }
  try { await request('DELETE', path); }
  catch (error) {
    if (!(error instanceof DockerError && error.status === 404)) throw error;
  }
}
