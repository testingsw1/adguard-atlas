import { describe, expect, it } from 'vitest';
import type { AtlasEvent } from '../src/shared/types';
import { Db } from '../src/server/db';
import { collectStats } from '../src/server/stats';

const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);

const ev = (i: number, patch: Partial<AtlasEvent> = {}): AtlasEvent => ({
  id: String(i),
  t: T0 + i * 1000,
  sub: 0,
  instance: 'one',
  client: 'tv',
  domain: `d${i % 3}.example`,
  qtype: 'A',
  cls: 'allowed',
  dest: { lat: 50.11, lon: 8.68, city: 'Frankfurt', country: 'Germany', cc: 'DE' },
  ...patch,
});

const sample = (): AtlasEvent[] => [
  ev(1),
  ev(2, { domain: 'd1.example' }),
  ev(3, { client: 'phone', cls: 'blocked', dest: undefined, domain: 'ads.example' }),
  ev(4, { client: 'phone', domain: 'news.example', dest: { lat: 35.68, lon: 139.69, city: 'Tokyo', country: 'Japan', cc: 'JP' } }),
];

describe('archive (SQLite)', () => {
  it('stores a query once, however often it is offered', () => {
    const db = new Db({ path: ':memory:' });
    expect(db.insertBatch(sample())).toHaveLength(4);
    expect(db.insertBatch(sample())).toHaveLength(0);
    expect(db.count()).toBe(4);
    db.close();
  });

  it('keeps two queries in the same millisecond apart', () => {
    const db = new Db({ path: ':memory:' });
    db.insertBatch([ev(1, { t: T0, sub: 1 }), ev(2, { t: T0, sub: 2 })]);
    expect(db.count()).toBe(2);
    db.close();
  });

  it('aggregates totals, blocked share and the top lists', () => {
    const db = new Db({ path: ':memory:' });
    db.insertBatch(sample());
    const now = T0 + 10_000;
    const stats = collectStats(db.handle, { range: 'all' }, now);

    expect(stats.total).toBe(4);
    expect(stats.byClass).toEqual({ allowed: 3, blocked: 1, local: 0, noanswer: 0 });
    expect(stats.blockedShare).toBeCloseTo(1 / 4);
    expect(stats.topCountries.map((r) => [r.cc, r.count])).toEqual([
      ['DE', 3],
      ['JP', 1],
    ]);
    expect(stats.topDevices.map((r) => [r.key, r.count])).toEqual([
      ['phone', 2],
      ['tv', 2],
    ]);
    expect(stats.places.map((p) => p.city)).toEqual(['Frankfurt', 'Tokyo']);
    expect(stats.devices).toEqual(['phone', 'tv']);
    expect(stats.instances).toEqual(['one']);
    expect(stats.buckets.reduce((sum, b) => sum + b[0] + b[1] + b[2], 0)).toBe(4);
    db.close();
  });

  it('drops a hidden class from the totals but not from its own counter', () => {
    const db = new Db({ path: ':memory:' });
    db.insertBatch(sample());
    const stats = collectStats(db.handle, { range: 'all', hidden: ['blocked'] }, T0 + 10_000);
    expect(stats.total).toBe(3);
    expect(stats.byClass.blocked).toBe(1);
    expect(stats.blockedShare).toBeCloseTo(1 / 4);
    db.close();
  });

  it('answers a time range from the index, and a click-through too', () => {
    const db = new Db({ path: ':memory:' });
    db.insertBatch(sample());

    const narrow = collectStats(db.handle, { range: '15m' }, T0 + 2 * 60 * 60_000);
    expect(narrow.total).toBe(0);

    const country = collectStats(db.handle, { range: 'all', country: 'JP', countryName: 'Japan' }, T0 + 10_000);
    expect(country.detail).toMatchObject({ title: 'Japan', total: 1, cities: [{ label: 'Tokyo' }] });

    const place = collectStats(
      db.handle,
      { range: 'all', place: `${50.11.toFixed(2)},${8.68.toFixed(2)}` },
      T0 + 10_000,
    );
    expect(place.detail).toMatchObject({ title: 'Frankfurt', subtitle: 'Germany', total: 3 });
    db.close();
  });
});
