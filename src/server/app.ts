import { startApp } from 'modelence/server';
import exampleModule from '@/server/example';
import registryModule from '@/server/core/registry';
import { createDemoUser } from '@/server/migrations/createDemoUser';
import { seedRegistry } from '@/server/core/registry/seed';

startApp({
  modules: [exampleModule, registryModule],

  security: {
    frameAncestors: ['https://modelence.com', 'https://*.modelence.com', 'http://localhost:*', 'https://*.exp.direct'],
  },

  migrations: [
    {
      version: 1,
      description: 'Create demo user',
      handler: createDemoUser,
    },
    {
      version: 2,
      description: 'Seed QUORUM core registry (chains, venues, tokens, jurisdictions) — dataOrigin: seed',
      handler: seedRegistry,
    },
  ],
});
