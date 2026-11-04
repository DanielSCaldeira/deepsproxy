export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export function productionConfig() {
  const origin = new URL(required('PUBLIC_ORIGIN'));
  if (origin.protocol !== 'https:' || origin.origin !== process.env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without trailing slash');
  for (const name of ['BOOTSTRAP_TOKEN', 'PROVISIONER_TOKEN', 'WORKER_MASTER_SECRET']) {
    if (required(name).length < 32) throw new Error(`${name} must have at least 32 characters`);
  }
  const maxWorkers = Number(process.env.MAX_ACTIVE_BROWSERS || 5);
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 20) throw new Error('Invalid MAX_ACTIVE_BROWSERS');
  return { origin: origin.origin, database: required('DATABASE_URL'), bootstrap: required('BOOTSTRAP_TOKEN'),
    provisioner: process.env.PROVISIONER_URL || 'http://provisioner:3001', provisionerToken: required('PROVISIONER_TOKEN'),
    workerMaster: required('WORKER_MASTER_SECRET'), maxWorkers };
}
export type ProductionConfig = ReturnType<typeof productionConfig>;
