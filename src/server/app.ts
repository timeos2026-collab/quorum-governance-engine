import { startApp } from 'modelence/server';
import exampleModule from '@/server/example';
import registryModule from '@/server/core/registry';
import evidenceModule from '@/server/core/evidence';
import agentsModule from '@/server/core/agents';
import debateModule from '@/server/core/debate';
import validationModule from '@/server/core/validation';
import { seedAgentRoster } from '@/server/core/agents/seed';
import { createDemoUser } from '@/server/migrations/createDemoUser';
import { seedRegistry } from '@/server/core/registry/seed';

startApp({
  modules: [
    exampleModule,
    registryModule,
    evidenceModule,
    agentsModule,
    debateModule,
    validationModule,
  ],

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
    {
      version: 3,
      description: 'Seed QUORUM core agent roster (8 core agents) — dataOrigin: seed',
      handler: seedAgentRoster,
    },
  ],
});
