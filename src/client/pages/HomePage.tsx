import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { modelenceQuery } from '@modelence/react-query';
import { AlertTriangle, ShieldAlert, Info } from 'lucide-react';

import Page from '@/client/components/Page';
import { cn } from '@/client/lib/utils';

type DataOrigin = 'seed' | 'ingested' | 'manual';

type Overview = {
  counts: { chains: number; venues: number; jurisdictions: number; tokens: number; facts: number };
  tokensByTier: { tier1: number; tier2: number; tier3: number };
  provenance: { seededTokens: number; ingestedTokens: number };
  jurisdictionFlags: { requiresPreApproval: number; exchangeControl: number };
};

type Chain = {
  chainId: string; name: string; consensus: string; finalityTimeSec: number;
  bridgeRiskRating: number; dataOrigin: DataOrigin; source: string; sourceTimestamp: string;
};

type Venue = {
  venueId: string; name: string; type: string; jurisdictionId: string; custodyModel: string;
  kycRequired: boolean; apiCoverage: string[]; dataOrigin: DataOrigin; sourceTimestamp: string;
};

type Jurisdiction = {
  jurisdictionId: string; name: string; regimeType: string; requiresPreApproval: boolean;
  exchangeControlFlag: boolean; notes: string | null; effectiveFrom: string;
  effectiveTo: string | null; source: string; sourceTimestamp: string; dataOrigin: DataOrigin;
};

type Token = {
  tokenId: string; symbol: string; name: string; chainId: string; category: string; tier: number;
  supplyModel: string; liquidityLockStatus: string; devWalletPct: number | null;
  top10HolderPct: number | null; contractAuditStatus: string; honeypotCheckResult: string;
  regulatoryStatus: string; capitalOriginJurisdictionId: string | null;
  liquidityVenueJurisdictionId: string | null; dataOrigin: DataOrigin; sourceTimestamp: string;
};

const TABS = ['tokens', 'jurisdictions', 'venues', 'chains'] as const;
type Tab = (typeof TABS)[number];

function OriginTag({ origin }: { origin: DataOrigin }) {
  const map: Record<DataOrigin, string> = {
    seed: 'border-caution-500/40 bg-caution-soft text-caution-500',
    ingested: 'border-verified-500/40 bg-verified-soft text-verified-500',
    manual: 'border-inferred-500/40 bg-inferred-soft text-inferred-500',
  };
  return (
    <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-wider', map[origin])}>
      {origin.toUpperCase()}
    </span>
  );
}

function StatusTag({ value, tone }: { value: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  const map = {
    ok: 'border-verified-500/40 bg-verified-soft text-verified-500',
    warn: 'border-caution-500/40 bg-caution-soft text-caution-500',
    bad: 'border-blocked-500/40 bg-blocked-soft text-blocked-500',
    neutral: 'border-line-strong bg-ink-600 text-fg-muted',
  } as const;
  return (
    <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-wider', map[tone])}>
      {value.toUpperCase()}
    </span>
  );
}

function regulatoryTone(status: string) {
  if (status === 'digital_commodity') return 'ok' as const;
  if (status === 'under_review') return 'warn' as const;
  return 'bad' as const;
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('animate-fade-in rounded-lg border border-line bg-ink-700', className)}>
      {children}
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="animate-slide-up rounded-lg border border-line bg-ink-700 p-4">
      <p className="label-caps">{label}</p>
      <p className="mt-1.5 font-mono text-2xl text-fg">{value}</p>
      {hint && <p className="mt-1 text-xs text-fg-faint">{hint}</p>}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="label-caps whitespace-nowrap px-3 py-2 text-left font-normal">{children}</th>;
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={cn('whitespace-nowrap px-3 py-2 text-sm text-fg-muted', mono && 'font-mono text-xs')}>
      {children}
    </td>
  );
}

function TableShell({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="border-b border-line bg-ink-600">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export default function HomePage() {
  const [tab, setTab] = useState<Tab>('tokens');

  const overview = useQuery(modelenceQuery<Overview>('registry.overview', {}));
  const tokens = useQuery(modelenceQuery<Token[]>('registry.listTokens', {}));
  const jurisdictions = useQuery(modelenceQuery<Jurisdiction[]>('registry.listJurisdictions', {}));
  const venues = useQuery(modelenceQuery<Venue[]>('registry.listVenues', {}));
  const chains = useQuery(modelenceQuery<Chain[]>('registry.listChains', {}));

  const o = overview.data;
  const allSeeded = !!o && o.provenance.ingestedTokens === 0;

  return (
    <Page
      seo={{
        title: 'Registry',
        description:
          'QUORUM shared registry: chains, venues, tokens and jurisdictions with versioned regulatory facts.',
      }}
      className="bg-ink-900"
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
        <header className="animate-fade-in">
          <p className="label-caps">Core Engine · Slice 1</p>
          <h1 className="mt-1 font-display text-2xl font-semibold">Shared Registry</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-fg-muted">
            The single reference layer every business line reads from — Trading, Private Equity,
            Private Credit, Investment Banking and AUM. Regulatory and jurisdictional facts are
            stored as versioned assertions with a source and an effective date, never as permanent
            truths.
          </p>
        </header>

        {allSeeded && (
          <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-caution-500/40 bg-caution-soft px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution-500" />
            <div>
              <p className="font-mono text-xs tracking-wider text-caution-500">
                SEEDED REFERENCE DATA — NOT LIVE
              </p>
              <p className="mt-1 text-sm text-fg-muted">
                No ingestion source is connected yet. Every row below was written by the registry
                seed migration and is tagged <span className="font-mono text-xs">SEED</span>. Nothing
                here may be treated as a live market, on-chain, or regulatory observation.
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Metric
            label="Tokens"
            value={o?.counts.tokens ?? '—'}
            hint={`T1 ${o?.tokensByTier.tier1 ?? 0} · T2 ${o?.tokensByTier.tier2 ?? 0} · T3 ${o?.tokensByTier.tier3 ?? 0}`}
          />
          <Metric
            label="Jurisdictions"
            value={o?.counts.jurisdictions ?? '—'}
            hint={`${o?.jurisdictionFlags.requiresPreApproval ?? 0} require pre-approval`}
          />
          <Metric label="Venues" value={o?.counts.venues ?? '—'} hint="CEX · DEX · launchpad · lending" />
          <Metric label="Chains" value={o?.counts.chains ?? '—'} hint="with bridge risk ratings" />
          <Metric label="Versioned facts" value={o?.counts.facts ?? '—'} hint="replayable assertions" />
          <Metric
            label="Exchange control"
            value={o?.jurisdictionFlags.exchangeControl ?? '—'}
            hint="capital-origin gating"
          />
        </div>

        <Panel>
          <div className="flex items-center gap-1 border-b border-line px-3 py-2">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'cursor-pointer rounded-md px-3 py-1.5 font-mono text-xs tracking-wider uppercase transition-colors duration-150',
                  tab === t
                    ? 'bg-signal-soft text-signal-400'
                    : 'text-fg-faint hover:bg-ink-600 hover:text-fg-muted'
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'tokens' && (
            <TableShell
              head={
                <>
                  <Th>Symbol</Th>
                  <Th>Tier</Th>
                  <Th>Category</Th>
                  <Th>Chain</Th>
                  <Th>LP lock</Th>
                  <Th>Dev %</Th>
                  <Th>Top-10 %</Th>
                  <Th>Audit</Th>
                  <Th>Honeypot</Th>
                  <Th>Reg. status</Th>
                  <Th>Capital origin</Th>
                  <Th>Liquidity venue</Th>
                  <Th>Origin</Th>
                </>
              }
            >
              {(tokens.data ?? []).map((t) => (
                <tr key={t.tokenId} className="transition-colors hover:bg-ink-600/60">
                  <Td>
                    <span className="font-mono text-sm text-fg">{t.symbol}</span>
                    <span className="ml-2 text-xs text-fg-faint">{t.name}</span>
                  </Td>
                  <Td mono>
                    <StatusTag
                      value={`T${t.tier}`}
                      tone={t.tier === 1 ? 'ok' : t.tier === 2 ? 'warn' : 'bad'}
                    />
                  </Td>
                  <Td mono>{t.category}</Td>
                  <Td mono>{t.chainId}</Td>
                  <Td mono>
                    <StatusTag
                      value={t.liquidityLockStatus}
                      tone={
                        t.liquidityLockStatus === 'locked'
                          ? 'ok'
                          : t.liquidityLockStatus === 'unlocked'
                            ? 'bad'
                            : 'warn'
                      }
                    />
                  </Td>
                  <Td mono>{t.devWalletPct ?? '—'}</Td>
                  <Td mono>{t.top10HolderPct ?? '—'}</Td>
                  <Td mono>{t.contractAuditStatus}</Td>
                  <Td mono>{t.honeypotCheckResult}</Td>
                  <Td mono>
                    <StatusTag value={t.regulatoryStatus} tone={regulatoryTone(t.regulatoryStatus)} />
                  </Td>
                  <Td mono>{t.capitalOriginJurisdictionId ?? '—'}</Td>
                  <Td mono>{t.liquidityVenueJurisdictionId ?? '—'}</Td>
                  <Td>
                    <OriginTag origin={t.dataOrigin} />
                  </Td>
                </tr>
              ))}
            </TableShell>
          )}

          {tab === 'jurisdictions' && (
            <div className="divide-y divide-line">
              {(jurisdictions.data ?? []).map((j) => (
                <div key={j.jurisdictionId} className="p-4 transition-colors hover:bg-ink-600/40">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-fg">{j.jurisdictionId}</span>
                    <h2 className="font-display text-base font-medium text-fg">{j.name}</h2>
                    <StatusTag value={j.regimeType} tone="neutral" />
                    {j.requiresPreApproval && (
                      <span className="flex items-center gap-1 rounded-sm border border-blocked-500/40 bg-blocked-soft px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-blocked-500">
                        <ShieldAlert className="size-3" /> PER-TOKEN PRE-APPROVAL
                      </span>
                    )}
                    {j.exchangeControlFlag && <StatusTag value="exchange control" tone="warn" />}
                    <span className="ml-auto">
                      <OriginTag origin={j.dataOrigin} />
                    </span>
                  </div>
                  {j.notes && (
                    <p className="mt-2 max-w-4xl text-sm leading-relaxed text-fg-muted">{j.notes}</p>
                  )}
                  <p className="mt-2 font-mono text-[11px] text-fg-faint">
                    effective_from {new Date(j.effectiveFrom).toISOString().slice(0, 10)} ·
                    effective_to{' '}
                    {j.effectiveTo ? new Date(j.effectiveTo).toISOString().slice(0, 10) : 'open'} ·
                    source {j.source}
                  </p>
                </div>
              ))}
            </div>
          )}

          {tab === 'venues' && (
            <TableShell
              head={
                <>
                  <Th>Venue</Th>
                  <Th>Type</Th>
                  <Th>Jurisdiction</Th>
                  <Th>Custody</Th>
                  <Th>KYC</Th>
                  <Th>API coverage</Th>
                  <Th>Origin</Th>
                </>
              }
            >
              {(venues.data ?? []).map((v) => (
                <tr key={v.venueId} className="transition-colors hover:bg-ink-600/60">
                  <Td>
                    <span className="text-fg">{v.name}</span>
                  </Td>
                  <Td mono>{v.type}</Td>
                  <Td mono>{v.jurisdictionId}</Td>
                  <Td mono>{v.custodyModel}</Td>
                  <Td mono>
                    <StatusTag
                      value={v.kycRequired ? 'required' : 'none'}
                      tone={v.kycRequired ? 'ok' : 'warn'}
                    />
                  </Td>
                  <Td mono>{v.apiCoverage.join(', ')}</Td>
                  <Td>
                    <OriginTag origin={v.dataOrigin} />
                  </Td>
                </tr>
              ))}
            </TableShell>
          )}

          {tab === 'chains' && (
            <TableShell
              head={
                <>
                  <Th>Chain</Th>
                  <Th>Consensus</Th>
                  <Th>Finality</Th>
                  <Th>Bridge risk</Th>
                  <Th>Origin</Th>
                </>
              }
            >
              {(chains.data ?? []).map((c) => (
                <tr key={c.chainId} className="transition-colors hover:bg-ink-600/60">
                  <Td>
                    <span className="text-fg">{c.name}</span>
                  </Td>
                  <Td mono>{c.consensus}</Td>
                  <Td mono>{c.finalityTimeSec}s</Td>
                  <Td mono>
                    <StatusTag
                      value={`${c.bridgeRiskRating}/5`}
                      tone={c.bridgeRiskRating <= 2 ? 'ok' : c.bridgeRiskRating <= 3 ? 'warn' : 'bad'}
                    />
                  </Td>
                  <Td>
                    <OriginTag origin={c.dataOrigin} />
                  </Td>
                </tr>
              ))}
            </TableShell>
          )}
        </Panel>

        <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-line bg-ink-700 px-4 py-3 text-sm text-fg-muted">
          <Info className="mt-0.5 size-4 shrink-0 text-fg-faint" />
          <p>
            <span className="text-fg">Registry, evidence ingestion, the agent swarm and the debate
            engine are built and running.</span>{' '}
            The remaining stages — validation, risk gate, paper/shadow execution and the five
            business-line modules — are not built yet and appear in the left rail as inert
            placeholders so the pipeline order stays visible while it is assembled. Nothing
            downstream of debate can authorise an action until the validation and risk-gate stages
            exist.
          </p>
        </div>
      </div>
    </Page>
  );
}
